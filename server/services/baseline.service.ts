import pLimit from 'p-limit';
import { supabase } from '../db/client.ts';

export interface BaselineComponents {
  recency_norm: number;
  outlet_norm: number;
  velocity_norm: number;
  age_hours: number;
  velocity: number;
  outlet_count: number;
}

export interface BaselineResult {
  score: number;
  components: BaselineComponents;
}

export interface RankedCluster {
  cluster_id: string;
  headline: string;
  score: number;
  components: BaselineComponents;
}

/**
 * Rounds a number to 4 decimal places.
 */
function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

/**
 * Pure function: calculates the baseline ranking score from raw component metrics.
 * 
 * Formula:
 *   recency_norm = exp(-0.08 * age_hours)
 *   outlet_norm = min(1.0, ln(1 + outlet_count) / ln(5))
 *   velocity_norm = min(1.0, velocity / 3.0)
 *   score = 0.40 * recency_norm + 0.35 * outlet_norm + 0.25 * velocity_norm
 */
export function computeScoreFromComponents(
  age_hours: number,
  velocity: number,
  outlet_count: number
): BaselineResult {
  const safeAgeHours = Math.max(0, age_hours);
  const safeVelocity = Math.max(0, velocity);
  const safeOutletCount = Math.max(0, outlet_count);

  const recency_norm = Math.exp(-0.08 * safeAgeHours);
  const outlet_norm = safeOutletCount <= 0
    ? 0
    : Math.min(1.0, Math.log(1 + safeOutletCount) / Math.log(5));
  const velocity_norm = Math.min(1.0, safeVelocity / 3.0);

  const rawScore = 0.40 * recency_norm + 0.35 * outlet_norm + 0.25 * velocity_norm;

  return {
    score: round4(rawScore),
    components: {
      recency_norm: round4(recency_norm),
      outlet_norm: round4(outlet_norm),
      velocity_norm: round4(velocity_norm),
      age_hours: round4(safeAgeHours),
      velocity: round4(safeVelocity),
      outlet_count: round4(safeOutletCount),
    },
  };
}

/**
 * Acquires an exclusive pipeline lock for the given runType with an expiration TTL.
 */
export async function acquirePipelineLock(runType: string, ttlMinutes = 15): Promise<boolean> {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();

  // 1. Check if an active, unexpired lock currently exists
  const { data: existing, error: selectError } = await supabase
    .from('pipeline_run_locks')
    .select('locked_until')
    .eq('run_type', runType)
    .maybeSingle();

  if (selectError && selectError.code !== 'PGRST116') {
    console.warn(`[PipelineLock] Select lock error: ${selectError.message}`);
  }

  if (existing?.locked_until) {
    const existingUntil = new Date(existing.locked_until).getTime();
    if (existingUntil > now.getTime()) {
      return false; // Active lock held by another process
    }
  }

  // 2. Lock is absent or expired: upsert with updated lock duration
  const { error: upsertError } = await supabase
    .from('pipeline_run_locks')
    .upsert({
      run_type: runType,
      locked_until: lockedUntil,
      locked_by: 'pipeline',
      locked_at: now.toISOString(),
    });

  if (upsertError) {
    console.warn(`[PipelineLock] Upsert lock error: ${upsertError.message}`);
    return false;
  }

  return true;
}

/**
 * Releases the pipeline lock for the given runType.
 */
export async function releasePipelineLock(runType: string): Promise<void> {
  const { error } = await supabase
    .from('pipeline_run_locks')
    .delete()
    .eq('run_type', runType);

  if (error) {
    console.warn(`[PipelineLock] Failed to release lock for ${runType}: ${error.message}`);
  }
}

/**
 * Computes the baseline score and components for a single cluster by its ID.
 * Returns score 0 gracefully for clusters with 0 articles.
 */
export async function computeBaselineScore(clusterId: string): Promise<{ score: number; components: BaselineComponents }> {
  // 1. Fetch all article links for this cluster
  const { data: links, error: linkError } = await supabase
    .from('cluster_articles')
    .select('article_id')
    .eq('cluster_id', clusterId);

  if (linkError) {
    throw new Error(`Failed to fetch cluster_articles for cluster ${clusterId}: ${linkError.message}`);
  }

  const articleIds = (links || []).map((l) => l.article_id).filter(Boolean);
  if (articleIds.length === 0) {
    return {
      score: 0,
      components: {
        recency_norm: 0,
        outlet_norm: 0,
        velocity_norm: 0,
        age_hours: 0,
        velocity: 0,
        outlet_count: 0,
      },
    };
  }

  // 2. Query articles details
  const { data: articles, error: articlesError } = await supabase
    .from('articles')
    .select('id, source_id, published_at, ingested_at')
    .in('id', articleIds);

  if (articlesError) {
    throw new Error(`Failed to fetch articles for cluster ${clusterId}: ${articlesError.message}`);
  }

  if (!articles || articles.length === 0) {
    return {
      score: 0,
      components: {
        recency_norm: 0,
        outlet_norm: 0,
        velocity_norm: 0,
        age_hours: 0,
        velocity: 0,
        outlet_count: 0,
      },
    };
  }

  const now = Date.now();
  const timestamps: number[] = [];
  let velocityCount = 0;
  const sourceIds = new Set<string>();

  for (const art of articles) {
    if (art.source_id) {
      sourceIds.add(art.source_id);
    }

    const timeStr = art.published_at || art.ingested_at;
    if (timeStr) {
      const ms = new Date(timeStr).getTime();
      if (!isNaN(ms)) {
        timestamps.push(ms);
        // velocity = count of articles published in the last 60 minutes
        if (now - ms <= 60 * 60 * 1000 && ms <= now + 5 * 60 * 1000) {
          velocityCount++;
        }
      }
    }
  }

  const earliestMs = timestamps.length > 0 ? Math.min(...timestamps) : now;
  const age_hours = Math.max(0, (now - earliestMs) / (1000 * 60 * 60));
  const velocity = velocityCount;
  const outlet_count = sourceIds.size;

  return computeScoreFromComponents(age_hours, velocity, outlet_count);
}

/**
 * Ranks clusters by baseline heuristics, records snapshots, and returns top N clusters.
 */
export async function rankClustersByBaseline(limit = 20): Promise<RankedCluster[]> {
  const locked = await acquirePipelineLock('baseline');
  if (!locked) {
    throw new Error('Another baseline run is in progress');
  }

  try {
    // Fetch all clusters with status IN ('pending', 'scored', 'editorial_ready')
    const { data: clusters, error: clusterError } = await supabase
      .from('clusters')
      .select('id, headline, status')
      .in('status', ['pending', 'scored', 'editorial_ready']);

    if (clusterError) {
      throw new Error(`Failed to fetch clusters: ${clusterError.message}`);
    }

    const clusterList = clusters || [];
    const computedAt = new Date().toISOString();
    const limitConcurrent = pLimit(10);

    const scoredItems = await Promise.all(
      clusterList.map((c) =>
        limitConcurrent(async () => {
          const { score, components } = await computeBaselineScore(c.id);
          return {
            ranked: {
              cluster_id: c.id,
              headline: c.headline || 'Untitled',
              score,
              components,
            },
            snapshot: {
              cluster_id: c.id,
              score,
              components,
              computed_at: computedAt,
            },
          };
        })
      )
    );

    const rankedList: RankedCluster[] = scoredItems.map((item) => item.ranked);
    const snapshotRows = scoredItems.map((item) => item.snapshot);

    // Insert snapshots if any were calculated
    if (snapshotRows.length > 0) {
      const { error: snapError } = await supabase
        .from('baseline_snapshots')
        .insert(snapshotRows);

      if (snapError) {
        console.warn(`[Baseline] Failed to record baseline snapshots: ${snapError.message}`);
      }
    }

    // Sort by score descending
    rankedList.sort((a, b) => b.score - a.score);

    // Return top N
    return rankedList.slice(0, limit);
  } finally {
    await releasePipelineLock('baseline');
  }
}
