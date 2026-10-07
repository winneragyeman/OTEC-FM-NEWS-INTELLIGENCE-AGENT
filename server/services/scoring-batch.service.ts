import { supabase } from '../db/client.ts';
import { isPipelineEnabled } from '../lib/system-flags.ts';
import { getPipelineConfigNumber } from '../lib/quota-tracker.ts';
import { QuotaExceededError } from '../lib/errors.ts';
import { acquirePipelineLock, releasePipelineLock } from './baseline.service.ts';
import { checkKeywords } from './keyword-backstop.service.ts';
import {
  scoreClusterBatch,
  DEFAULT_SCORING_MODEL,
  DEFAULT_FALLBACK_MODEL,
  ScoreResult,
} from './scoring.service.ts';

export interface ScoringPipelineSummary {
  clusters_processed: number;
  clusters_scored: number;
  clusters_held: number;
  clusters_rejected: number;
  api_calls: number;
  cost_cents: number;
  primary_model: string;
  fallback_used: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function is429Error(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.toLowerCase().includes('rate limit') ||
    msg.toLowerCase().includes('quota')
  );
}

/**
 * Runs the end-to-end LLM scoring pipeline:
 * 1. Checks kill switch (isPipelineEnabled)
 * 2. Acquires exclusive 'scoring' pipeline lock (30 min TTL)
 * 3. Fetches top funnelSize clusters by most recent baseline snapshot with status='pending'
 * 4. Runs keyword backstop check
 * 5. Batches clusters and scores them using primary Gemini model (falling back to fallback model on quota exhaustion)
 * 6. Handles 429 rate limit backoff and 6-second inter-batch pauses
 * 7. Releases lock and returns summary
 */
export async function runScoringPipeline(
  customFunnelSize?: number,
  customBatchSize?: number
): Promise<ScoringPipelineSummary> {
  const primaryModel = process.env.GEMINI_MODEL_SCORING || DEFAULT_SCORING_MODEL;
  const fallbackModel = process.env.GEMINI_MODEL_FALLBACK || DEFAULT_FALLBACK_MODEL;

  let activeModel = primaryModel;
  let fallbackUsed = false;
  let apiCallsCount = 0;

  // Step a: Check kill switch
  const enabled = await isPipelineEnabled();
  if (!enabled) {
    console.warn('[ScoringPipeline] Ingestion/Scoring pipeline is currently disabled via system flags.');
    return {
      clusters_processed: 0,
      clusters_scored: 0,
      clusters_held: 0,
      clusters_rejected: 0,
      api_calls: 0,
      cost_cents: 0,
      primary_model: primaryModel,
      fallback_used: false,
    };
  }

  // Step b: Acquire exclusive pipeline lock with 30-minute TTL
  const lockAcquired = await acquirePipelineLock('scoring', 30);
  if (!lockAcquired) {
    throw new Error('Pipeline lock could not be acquired: another scoring run is currently active.');
  }

  try {
    const funnelSize =
      customFunnelSize ?? (await getPipelineConfigNumber('scoring_funnel_size', 30));
    const batchSize =
      customBatchSize ?? (await getPipelineConfigNumber('scoring_batch_size', 5));

    // Step c.i: Fetch pending clusters
    const { data: pendingClusters, error: pendingErr } = await supabase
      .from('clusters')
      .select('id, headline, combined_text, locations, status, created_at')
      .eq('status', 'pending');

    if (pendingErr) {
      throw new Error(`Failed to fetch pending clusters: ${pendingErr.message}`);
    }

    if (!pendingClusters || pendingClusters.length === 0) {
      return {
        clusters_processed: 0,
        clusters_scored: 0,
        clusters_held: 0,
        clusters_rejected: 0,
        api_calls: 0,
        cost_cents: 0,
        primary_model: primaryModel,
        fallback_used: false,
      };
    }

    // Rank pending clusters by their most recent baseline snapshot score
    const clusterIds = pendingClusters.map((c) => c.id);
    const { data: snapshots } = await supabase
      .from('baseline_snapshots')
      .select('cluster_id, score, computed_at')
      .in('cluster_id', clusterIds)
      .order('computed_at', { ascending: false });

    const baselineScoreMap = new Map<string, number>();
    for (const snap of snapshots || []) {
      if (!baselineScoreMap.has(snap.cluster_id)) {
        baselineScoreMap.set(snap.cluster_id, Number(snap.score) || 0);
      }
    }

    pendingClusters.sort((a, b) => {
      const scoreA = baselineScoreMap.get(a.id) ?? -1;
      const scoreB = baselineScoreMap.get(b.id) ?? -1;
      return scoreB - scoreA;
    });

    const candidateClusters = pendingClusters.slice(0, funnelSize);

    // Step c.ii: Run keyword backstop for each cluster in memory
    const keywordMatches: typeof candidateClusters = [];
    const standardClusters: typeof candidateClusters = [];

    for (const cluster of candidateClusters) {
      const rawText = `${cluster.headline || ''}\n\n${cluster.combined_text || ''}`.trim();
      const kwResult = checkKeywords(rawText);
      if (kwResult.matched) {
        keywordMatches.push(cluster);
      } else {
        standardClusters.push(cluster);
      }
    }

    // Step c.iii & c.iv: Prepare batches for both groups
    function createBatches<T>(items: T[], size: number): T[][] {
      const chunks: T[][] = [];
      for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
      }
      return chunks;
    }

    const allBatches = [
      ...createBatches(keywordMatches, batchSize),
      ...createBatches(standardClusters, batchSize),
    ];

    const results: ScoreResult[] = [];

    // Helper to log fallback in audit_log
    async function triggerFallback(reason: string) {
      if (!fallbackUsed) {
        fallbackUsed = true;
        activeModel = fallbackModel;
        console.warn(`[ScoringPipeline] Quota exhausted on primary model ${primaryModel}. Switching to fallback ${fallbackModel}. Reason: ${reason}`);

        try {
          await supabase.from('audit_log').insert({
            action: 'model_fallback',
            details: {
              from_model: primaryModel,
              to_model: fallbackModel,
              reason,
            },
            created_at: new Date().toISOString(),
          });
        } catch {
          // audit_log insert error ignored
        }
      }
    }

    // Step c.v: Process each batch
    for (let bIndex = 0; bIndex < allBatches.length; bIndex++) {
      const batch = allBatches[bIndex];
      const batchIds = batch.map((c) => c.id);

      async function attemptBatchCall(modelToUse: string): Promise<ScoreResult[]> {
        apiCallsCount++;
        return await scoreClusterBatch(batchIds, modelToUse);
      }

      let batchResults: ScoreResult[] | null = null;

      try {
        batchResults = await attemptBatchCall(activeModel);
      } catch (firstErr) {
        if (firstErr instanceof QuotaExceededError) {
          await triggerFallback('quota_exhausted');
          try {
            batchResults = await attemptBatchCall(activeModel);
          } catch (fallbackErr) {
            console.error(`[ScoringPipeline] Fallback model failed for batch:`, fallbackErr);
            continue;
          }
        } else if (is429Error(firstErr)) {
          // Step c.vi: If 429, pause 30 seconds and retry once
          console.warn('[ScoringPipeline] 429 rate limit hit. Pausing 30 seconds before single retry...');
          await sleep(30000);
          try {
            batchResults = await attemptBatchCall(activeModel);
          } catch (retryErr) {
            if (retryErr instanceof QuotaExceededError) {
              await triggerFallback('quota_exhausted_on_retry');
              try {
                batchResults = await attemptBatchCall(activeModel);
              } catch (fallbackErr) {
                console.error(`[ScoringPipeline] Batch failed after retry and fallback:`, fallbackErr);
                continue;
              }
            } else {
              console.error(`[ScoringPipeline] Batch retry failed:`, retryErr);
              continue;
            }
          }
        } else {
          console.error(`[ScoringPipeline] Batch call failed unexpectedly:`, firstErr);
          continue;
        }
      }

      if (batchResults) {
        results.push(...batchResults);
      }

      // Step c.viii: Sleep 6 seconds between batches to respect rate limits
      if (bIndex < allBatches.length - 1) {
        await sleep(6000);
      }
    }

    let clustersScored = 0;
    let clustersHeld = 0;
    let clustersRejected = 0;

    for (const r of results) {
      if (r.route === 'scored') clustersScored++;
      else if (r.route === 'hold') clustersHeld++;
      else if (r.route === 'rejected') clustersRejected++;
    }

    // Calculate cost in cents for the run from llm_usage
    let costCents = 0;
    try {
      const scoredClusterIds = results.map((r) => r.score.cluster_id);
      if (scoredClusterIds.length > 0) {
        const { data: usageRows } = await supabase
          .from('llm_usage')
          .select('estimated_cost_cents')
          .in('cluster_id', scoredClusterIds);

        costCents = (usageRows || []).reduce(
          (sum, row) => sum + (Number(row.estimated_cost_cents) || 0),
          0
        );
      }
    } catch {
      // Ignore cost query failure
    }

    return {
      clusters_processed: results.length,
      clusters_scored: clustersScored,
      clusters_held: clustersHeld,
      clusters_rejected: clustersRejected,
      api_calls: apiCallsCount,
      cost_cents: Number(costCents.toFixed(2)),
      primary_model: primaryModel,
      fallback_used: fallbackUsed,
    };
  } finally {
    // Step d: Release lock in finally
    await releasePipelineLock('scoring');
  }
}
