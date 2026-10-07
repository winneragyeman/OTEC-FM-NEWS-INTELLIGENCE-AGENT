import { supabase } from '../db/client.ts';
import { DatabaseError } from '../lib/errors.ts';

export interface TrendSignal {
  outlet_count: number;
  velocity: number;
  recency_score: number;
}

/**
 * Computes trend metrics for a given cluster:
 * - outlet_count: unique source_id count across articles in this cluster.
 * - velocity: count of articles in this cluster published in the last 60 minutes.
 * - recency_score: 1.0 if latest article is < 30 min old; 0.5 if < 2 hours; 0.2 if < 6 hours; 0.0 otherwise.
 */
export async function computeTrendSignal(clusterId: string): Promise<TrendSignal> {
  if (!clusterId) {
    throw new Error('clusterId is required to compute trend signal');
  }

  // Fetch article IDs associated with this cluster
  const { data: clusterLinks, error: linkError } = await supabase
    .from('cluster_articles')
    .select('article_id')
    .eq('cluster_id', clusterId);

  if (linkError) {
    throw new DatabaseError(`Failed to fetch cluster_articles for cluster ${clusterId}: ${linkError.message}`, linkError);
  }

  const articleIds = (clusterLinks || []).map((row) => row.article_id).filter(Boolean);

  if (articleIds.length === 0) {
    return {
      outlet_count: 0,
      velocity: 0,
      recency_score: 0.0,
    };
  }

  // Fetch article source_id and published_at
  const { data: articles, error: articlesError } = await supabase
    .from('articles')
    .select('id, source_id, published_at')
    .in('id', articleIds);

  if (articlesError) {
    throw new DatabaseError(`Failed to fetch articles for trend signal: ${articlesError.message}`, articlesError);
  }

  const now = Date.now();
  const sixtyMinutesAgo = now - 60 * 60 * 1000;

  const uniqueSources = new Set<string>();
  let velocity = 0;
  let latestPublishedAtMs = 0;

  for (const article of articles || []) {
    if (article.source_id) {
      uniqueSources.add(article.source_id);
    }

    if (article.published_at) {
      const pubTime = new Date(article.published_at).getTime();
      if (!isNaN(pubTime)) {
        if (pubTime >= sixtyMinutesAgo && pubTime <= now + 5 * 60 * 1000) {
          velocity++;
        }
        if (pubTime > latestPublishedAtMs) {
          latestPublishedAtMs = pubTime;
        }
      }
    }
  }

  // Calculate recency score based on latest article age
  let recencyScore = 0.0;
  if (latestPublishedAtMs > 0) {
    const ageMinutes = (now - latestPublishedAtMs) / (60 * 1000);
    if (ageMinutes < 30) {
      recencyScore = 1.0;
    } else if (ageMinutes < 120) {
      recencyScore = 0.5;
    } else if (ageMinutes < 360) {
      recencyScore = 0.2;
    } else {
      recencyScore = 0.0;
    }
  }

  return {
    outlet_count: uniqueSources.size,
    velocity,
    recency_score: recencyScore,
  };
}
