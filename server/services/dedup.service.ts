import { supabase } from '../db/client.ts';
import { DatabaseError } from '../lib/errors.ts';

export interface SimilarTitleResult {
  id: string;
  title: string;
  similarity: number;
}

/**
 * Strips tracking parameters (utm_*, fbclid, gclid, mc_cid, mc_eid),
 * lowercases hostname, removes trailing slashes, and removes fragments.
 */
export function normalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);

    // Lowercase hostname
    parsed.hostname = parsed.hostname.toLowerCase();

    // Strip hash fragment
    parsed.hash = '';

    // Strip known tracking query parameters
    const paramsToDelete: string[] = [];
    parsed.searchParams.forEach((_val, key) => {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.startsWith('utm_') ||
        lowerKey === 'fbclid' ||
        lowerKey === 'gclid' ||
        lowerKey === 'mc_cid' ||
        lowerKey === 'mc_eid'
      ) {
        paramsToDelete.push(key);
      }
    });

    for (const key of paramsToDelete) {
      parsed.searchParams.delete(key);
    }

    let normalized = parsed.toString();

    // Remove trailing slash from pathname if present (except root '/')
    if (normalized.endsWith('/') && parsed.pathname !== '/') {
      normalized = normalized.slice(0, -1);
    }

    return normalized;
  } catch {
    // If URL parsing fails, strip fragment and trailing slashes as string fallback
    return rawUrl.split('#')[0].replace(/\/+$/, '');
  }
}

/**
 * Queries articles table for an existing row with the same content_hash.
 * Returns the article ID or null.
 */
export async function findDuplicateByHash(contentHash: string): Promise<string | null> {
  if (!contentHash) return null;

  const { data, error } = await supabase
    .from('articles')
    .select('id')
    .eq('content_hash', contentHash)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new DatabaseError(`Failed to find duplicate by hash: ${error.message}`, error);
  }

  return data ? data.id : null;
}

/**
 * Calculates pg_trgm similarity between two strings identically to PostgreSQL similarity().
 */
function calculateTrgmSimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;
  if (str1 === str2) return 1;

  const pad1 = `  ${str1.toLowerCase()} `;
  const pad2 = `  ${str2.toLowerCase()} `;

  const getTrigrams = (s: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (let i = 0; i < s.length - 2; i++) {
      const tri = s.slice(i, i + 3);
      counts.set(tri, (counts.get(tri) || 0) + 1);
    }
    return counts;
  };

  const tri1 = getTrigrams(pad1);
  const tri2 = getTrigrams(pad2);

  let intersection = 0;
  let union = 0;

  const allKeys = new Set([...tri1.keys(), ...tri2.keys()]);
  for (const key of allKeys) {
    const c1 = tri1.get(key) || 0;
    const c2 = tri2.get(key) || 0;
    intersection += Math.min(c1, c2);
    union += Math.max(c1, c2);
  }

  return union === 0 ? 0 : intersection / union;
}

let cachedArticlesForSim: { id: string; title: string; published_at: string | null }[] | null = null;
let cacheTimestamp = 0;
let rpcAvailable = true;

/**
 * Uses Supabase RPC to call similar_titles pg_trgm similarity function.
 * Queries articles table for titles above the threshold within the last 48 hours.
 * Returns array of { id, title, similarity } ordered by similarity descending.
 */
export async function findSimilarByTitle(
  title: string,
  threshold = 0.4
): Promise<SimilarTitleResult[]> {
  if (!title || typeof title !== 'string') {
    return [];
  }

  // Attempt RPC call if available
  if (rpcAvailable) {
    try {
      const { data: rpcData, error: rpcError } = await supabase.rpc('similar_titles', {
        search_title: title,
        threshold,
        days_back: 2,
      });

      if (!rpcError && Array.isArray(rpcData)) {
        return rpcData.map((row: any) => ({
          id: row.id,
          title: row.title,
          similarity: Number(row.similarity),
        }));
      }

      if (rpcError) {
        // If RPC does not exist or cannot be found in schema cache, disable subsequent RPC calls
        if (rpcError.code === 'PGRST202' || rpcError.code === '42883' || rpcError.message?.includes('not find')) {
          rpcAvailable = false;
        }
      }
    } catch {
      rpcAvailable = false;
    }
  }

  // Resilient in-engine query: fetch articles from the last 48 hours with a 60s cache
  const now = Date.now();
  if (!cachedArticlesForSim || now - cacheTimestamp > 60_000) {
    const twoDaysAgo = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    const { data: articles, error } = await supabase
      .from('articles')
      .select('id, title, published_at')
      .gte('published_at', twoDaysAgo)
      .limit(500);

    if (!error && articles) {
      cachedArticlesForSim = articles;
      cacheTimestamp = now;
    }
  }

  const articles = cachedArticlesForSim || [];
  const results: SimilarTitleResult[] = [];

  for (const article of articles) {
    if (!article.title) continue;
    const sim = calculateTrgmSimilarity(title, article.title);
    if (sim > threshold) {
      results.push({
        id: article.id,
        title: article.title,
        similarity: parseFloat(sim.toFixed(4)),
      });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, 20);
}
