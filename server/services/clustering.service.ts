import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import pLimit from 'p-limit';
import { supabase } from '../db/client.ts';
import { logUsage } from '../lib/cost-tracker.ts';
import { isPipelineEnabled } from '../lib/system-flags.ts';
import { findSimilarByTitle } from './dedup.service.ts';
import { findLocations } from './gazetteer.service.ts';

export interface ClusteringSummary {
  articles_processed: number;
  clusters_created: number;
  merged_pairs: number;
  classifier_calls: number;
}

interface PendingArticle {
  id: string;
  source_id: string | null;
  title: string;
  body: string | null;
  published_at: string | null;
  ingested_at?: string;
}

// In-memory cache for classifier decisions across process lifetime
const classifierCache = new Map<string, { same_event: boolean; confidence: number }>();

// Zod schema for classifier validation
const ClassifierOutputSchema = z.object({
  same_event: z.boolean(),
  confidence: z.number().min(0).max(1).optional().default(0.5),
});

// Union-Find / Disjoint Set implementation
class DisjointSet {
  parent: Map<string, string> = new Map();

  find(item: string): string {
    if (!this.parent.has(item)) {
      this.parent.set(item, item);
      return item;
    }
    const p = this.parent.get(item)!;
    if (p !== item) {
      const root = this.find(p);
      this.parent.set(item, root);
      return root;
    }
    return p;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) {
      this.parent.set(rootB, rootA);
    }
  }
}

/**
 * Delays execution for ms milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Timestamp of last classifier request to enforce 6-second interval to stay under free-tier RPM limit
let lastClassifierCallTime = 0;
const classifierCallMutex = async (): Promise<void> => {
  const now = Date.now();
  const elapsed = now - lastClassifierCallTime;
  if (elapsed < 6000) {
    const waitTime = 6000 - elapsed;
    await sleep(waitTime);
  }
  lastClassifierCallTime = Date.now();
};

/**
 * Calls Gemini classifier to determine if two headlines refer to the same news event.
 * Uses process.env.GEMINI_MODEL_CLASSIFIER (default: "gemini-3.5-flash-lite").
 * Concurrency capped at 2, delays 4s between calls, retries once after 5s on failure,
 * logs token usage to llm_usage, and defaults to { same_event: false } on error.
 */
async function classifyHeadlines(
  titleA: string,
  titleB: string,
  stats: { classifier_calls: number }
): Promise<{ same_event: boolean; confidence: number }> {
  const cacheKey = [titleA, titleB].sort().join('||');

  // Layer 1: in-memory
  if (classifierCache.has(cacheKey)) {
    return classifierCache.get(cacheKey)!;
  }

  // Layer 2: persistent database cache
  try {
    const { data: dbCached } = await supabase
      .from('classifier_cache')
      .select('same_event, confidence')
      .eq('pair_key', cacheKey)
      .maybeSingle();

    if (dbCached) {
      const result = {
        same_event: Boolean(dbCached.same_event),
        confidence: Number(dbCached.confidence ?? 0),
      };
      classifierCache.set(cacheKey, result);
      return result;
    }
  } catch (cacheErr) {
    console.warn('[Clustering] Persistent cache lookup failed, continuing:', cacheErr);
  }

  const modelId = process.env.GEMINI_MODEL_CLASSIFIER || 'gemini-3.5-flash-lite';
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.warn('[Clustering] GEMINI_API_KEY is not set, defaulting classifier to false');
    return { same_event: false, confidence: 0 };
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      retryOptions: {
        attempts: 1,
      },
    },
  });

  const executeCall = async (): Promise<{ same_event: boolean; confidence: number }> => {
    await classifierCallMutex();
    stats.classifier_calls++;

    const delimiter = `===${crypto.randomBytes(8).toString('hex')}===`;
    const systemInstruction =
      'You are a strict news intelligence event classifier. Are these two headlines about the same event? ' +
      'Reply ONLY with JSON { "same_event": true/false, "confidence": 0-1 }. ' +
      'Be strict: two different accidents on different days are not the same event. ' +
      'Two stories about the same policy announcement from different outlets ARE the same event.';

    const userPrompt =
      `${delimiter}\n` +
      `Headline 1: ${titleA}\n` +
      `Headline 2: ${titleB}\n` +
      `${delimiter}\n` +
      `Respond in JSON schema format: { "same_event": boolean, "confidence": number }`;

    const response = await ai.models.generateContent({
      model: modelId,
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
      },
    });

    const responseText = response.text?.trim() || '{}';
    const parsedJson = JSON.parse(responseText);
    const validated = ClassifierOutputSchema.parse(parsedJson);

    const promptTokens = response.usageMetadata?.promptTokenCount || 50;
    const outputTokens = response.usageMetadata?.candidatesTokenCount || 20;
    const estimatedCostCents =
      (promptTokens * 0.0075 + outputTokens * 0.03) / 1000;

    try {
      await logUsage(
        modelId,
        'clustering_classification',
        promptTokens,
        outputTokens,
        estimatedCostCents,
        null
      );
    } catch (logErr) {
      console.warn('[Clustering] Failed to log classifier usage:', logErr);
    }

    return {
      same_event: validated.same_event,
      confidence: validated.confidence,
    };
  };

  try {
    const result = await executeCall();
    try {
      await supabase.from('classifier_cache').upsert({
        pair_key: cacheKey,
        same_event: result.same_event,
        confidence: result.confidence,
      }, { onConflict: 'pair_key' });
    } catch (cacheWriteErr) {
      console.warn('[Clustering] Failed to write to persistent classifier cache:', cacheWriteErr);
    }
    classifierCache.set(cacheKey, result);
    return result;
  } catch (firstErr) {
    console.warn(`[Clustering] Classifier attempt 1 failed (${firstErr instanceof Error ? firstErr.message : String(firstErr)}), retrying after 5 seconds...`);
    await sleep(5000);

    try {
      const retryResult = await executeCall();
      try {
        await supabase.from('classifier_cache').upsert({
          pair_key: cacheKey,
          same_event: retryResult.same_event,
          confidence: retryResult.confidence,
        }, { onConflict: 'pair_key' });
      } catch (cacheWriteErr) {
        console.warn('[Clustering] Failed to write to persistent classifier cache:', cacheWriteErr);
      }
      classifierCache.set(cacheKey, retryResult);
      return retryResult;
    } catch (secondErr) {
      console.warn(`[Clustering] Classifier attempt 2 failed (${secondErr instanceof Error ? secondErr.message : String(secondErr)}). Defaulting strictly to same_event: false`);
      const fallback = { same_event: false, confidence: 0 };
      classifierCache.set(cacheKey, fallback);
      return fallback;
    }
  }
}

/**
 * Safety cleanup run at the start of clusterArticles():
 * 1. Deletes any clusters that have zero articles (orphans).
 * 2. Deletes any cluster_articles links for articles currently in 'pending' status
 *    or that no longer exist, ensuring no stale links persist.
 */
async function runSafetyCleanup(): Promise<void> {
  try {
    // a. Find and delete cluster_articles referencing pending articles (stale from aborted runs)
    const { data: pendingArticles } = await supabase
      .from('articles')
      .select('id')
      .eq('status', 'pending');

    const pendingIds = (pendingArticles || []).map((a) => a.id);
    if (pendingIds.length > 0) {
      const chunkSize = 100;
      for (let i = 0; i < pendingIds.length; i += chunkSize) {
        const chunk = pendingIds.slice(i, i + chunkSize);
        await supabase
          .from('cluster_articles')
          .delete()
          .in('article_id', chunk);
      }
    }

    // b. Find and delete orphan clusters (clusters with zero articles in cluster_articles)
    const { data: allLinks } = await supabase
      .from('cluster_articles')
      .select('cluster_id');

    const linkedClusterIds = new Set((allLinks || []).map((l) => l.cluster_id));

    const { data: allClusters } = await supabase
      .from('clusters')
      .select('id');

    const orphanClusterIds = (allClusters || [])
      .map((c) => c.id)
      .filter((id) => !linkedClusterIds.has(id));

    if (orphanClusterIds.length > 0) {
      const chunkSize = 100;
      for (let i = 0; i < orphanClusterIds.length; i += chunkSize) {
        const chunk = orphanClusterIds.slice(i, i + chunkSize);
        await supabase
          .from('clusters')
          .delete()
          .in('id', chunk);
      }
    }
  } catch (err) {
    console.warn('[Clustering] Safety cleanup encountered non-fatal error:', err);
  }
}

/**
 * Main entry point: clusters all pending articles from the last 48 hours.
 */
export async function clusterArticles(): Promise<ClusteringSummary> {
  if (!(await isPipelineEnabled())) {
    console.warn('[Clustering] Pipeline disabled. Skipping run.');
    return { articles_processed: 0, clusters_created: 0, merged_pairs: 0, classifier_calls: 0 };
  }

  const todayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
  const { count: todayCount } = await supabase
    .from('llm_usage')
    .select('*', { count: 'exact', head: true })
    .eq('task', 'clustering_classification')
    .gte('created_at', todayStart);

  if ((todayCount ?? 0) >= 450) {
    throw new Error(
      `Daily classifier quota near limit (${todayCount}/500). Aborting run to protect remaining quota.`
    );
  }

  const summary: ClusteringSummary = {
    articles_processed: 0,
    clusters_created: 0,
    merged_pairs: 0,
    classifier_calls: 0,
  };

  // Step 0: Run safety guard cleanup before processing
  await runSafetyCleanup();

  // Step a: Fetch all articles with status = 'pending' from the last 48 hours
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data: rawArticles, error: fetchError } = await supabase
    .from('articles')
    .select('id, source_id, title, body, published_at, ingested_at')
    .eq('status', 'pending')
    .gte('published_at', twoDaysAgo)
    .order('published_at', { ascending: false });

  if (fetchError) {
    throw new Error(`Failed to fetch pending articles for clustering: ${fetchError.message}`);
  }

  const articles: PendingArticle[] = (rawArticles as PendingArticle[]) || [];
  summary.articles_processed = articles.length;

  if (articles.length === 0) {
    return summary;
  }

  const articleMap = new Map<string, PendingArticle>();
  for (const a of articles) {
    articleMap.set(a.id, a);
  }

  const dsu = new DisjointSet();
  for (const a of articles) {
    dsu.find(a.id);
  }

  // Step b & c: Find similar titles and evaluate candidate pairs
  const candidatePairs: { aId: string; bId: string; sim: number }[] = [];
  const seenPairKeys = new Set<string>();

  for (const article of articles) {
    if (!article.title) continue;
    const candidates = await findSimilarByTitle(article.title, 0.4);

    for (const cand of candidates) {
      if (cand.id === article.id) continue;
      if (!articleMap.has(cand.id)) continue;

      const pairKey = [article.id, cand.id].sort().join('::');
      if (seenPairKeys.has(pairKey)) continue;
      seenPairKeys.add(pairKey);

      candidatePairs.push({
        aId: article.id,
        bId: cand.id,
        sim: cand.similarity,
      });
    }
  }

  // Concurrency limiter for classifier calls (cap at 1)
  const limit = pLimit(1);
  const classifierTasks: Promise<void>[] = [];

  for (const pair of candidatePairs) {
    if (pair.sim >= 0.75) {
      // Auto-merge: high title similarity
      dsu.union(pair.aId, pair.bId);
      summary.merged_pairs++;
    } else if (pair.sim >= 0.4 && pair.sim < 0.75) {
      // Step d: Run classifier via rate-limited queue
      classifierTasks.push(
        limit(async () => {
          const artA = articleMap.get(pair.aId)!;
          const artB = articleMap.get(pair.bId)!;

          const decision = await classifyHeadlines(
            artA.title,
            artB.title,
            summary
          );

          if (decision.same_event) {
            dsu.union(pair.aId, pair.bId);
            summary.merged_pairs++;
          }
        })
      );
    }
  }

  if (classifierTasks.length > 0) {
    await Promise.all(classifierTasks);
  }

  // Step e: Group articles into clusters via union-find roots
  const clusterGroups = new Map<string, PendingArticle[]>();
  for (const article of articles) {
    const root = dsu.find(article.id);
    if (!clusterGroups.has(root)) {
      clusterGroups.set(root, []);
    }
    clusterGroups.get(root)!.push(article);
  }

  // Step f & g: Persist clusters idempotently in single logical units with rollback
  const persistLimit = pLimit(5);

  const persistTasks = Array.from(clusterGroups.values()).map((group) =>
    persistLimit(async () => {
      const groupArticleIds = group.map((a) => a.id);

      // Check if any article in this cluster is already linked to an existing cluster
      const { data: existingLinks, error: checkError } = await supabase
        .from('cluster_articles')
        .select('article_id')
        .in('article_id', groupArticleIds);

      if (checkError) {
        console.error(`[Clustering] Error verifying existing links for group:`, checkError);
        return;
      }

      if (existingLinks && existingLinks.length > 0) {
        // Skip inserting: one or more articles already belong to a cluster
        console.warn(`[Clustering] Skipping cluster insert: articles already linked to another cluster`);
        return;
      }

      // Sort articles in cluster by published_at descending
      group.sort((a, b) => {
        const timeA = new Date(a.published_at || a.ingested_at || 0).getTime();
        const timeB = new Date(b.published_at || b.ingested_at || 0).getTime();
        return timeB - timeA;
      });

      const primaryArticle = group[0];
      const combinedText = group
        .map((a) => `${a.title}\n\n${a.body || ''}`.trim())
        .filter(Boolean)
        .join('\n\n---\n\n');

      const uniqueSources = new Set(group.map((a) => a.source_id).filter(Boolean));
      const uniqueSourceCount = uniqueSources.size;
      const articleCount = group.length;
      const sourceDiversity = uniqueSourceCount > 1 ? 'MULTI_SOURCE' : 'SINGLE_SOURCE';
      const locations = findLocations(combinedText);

      // 1. Insert cluster record
      const { data: createdCluster, error: clusterError } = await supabase
        .from('clusters')
        .insert({
          headline: primaryArticle.title,
          combined_text: combinedText,
          article_count: articleCount,
          unique_source_count: uniqueSourceCount,
          source_diversity: sourceDiversity,
          locations: locations,
          status: 'pending',
          version: 1,
        })
        .select('id')
        .single();

      if (clusterError || !createdCluster) {
        console.error(`[Clustering] Failed to insert cluster for headline "${primaryArticle.title}":`, clusterError);
        return;
      }

      const clusterId = createdCluster.id;

      // 2. Insert cluster_articles relations
      const clusterArticleEntries = group.map((a) => ({
        cluster_id: clusterId,
        article_id: a.id,
      }));

      const { error: relError } = await supabase
        .from('cluster_articles')
        .insert(clusterArticleEntries);

      if (relError) {
        console.error(`[Clustering] Failed to insert cluster_articles for cluster ${clusterId}. Rolling back cluster:`, relError);
        // Rollback: delete the created cluster immediately
        await supabase.from('clusters').delete().eq('id', clusterId);
        return;
      }

      // 3. Update articles status to 'clustered'
      const { error: statusError } = await supabase
        .from('articles')
        .update({ status: 'clustered' })
        .in('id', groupArticleIds);

      if (statusError) {
        console.error(`[Clustering] Failed to update article status for cluster ${clusterId}. Rolling back cluster and links:`, statusError);
        // Rollback: delete cluster_articles links and cluster immediately
        await supabase.from('cluster_articles').delete().eq('cluster_id', clusterId);
        await supabase.from('clusters').delete().eq('id', clusterId);
        return;
      }

      // Only increment upon successful completion of all 3 operations
      summary.clusters_created++;
    })
  );

  await Promise.all(persistTasks);

  return summary;
}
