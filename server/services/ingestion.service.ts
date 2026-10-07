import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import YAML from 'yaml';
import pLimit from 'p-limit';
import { supabase } from '../db/client.ts';
import { safeFetch } from './ssrf.service.ts';
import { isPipelineEnabled } from '../lib/system-flags.ts';

export interface FeedItem {
  title: string;
  link: string;
  pubDate: string | null;
  content: string;
  summary: string;
}

export interface SourceConfig {
  id?: string;
  name: string;
  type: string;
  url: string;
  region: string;
  active?: boolean;
  status?: string;
  article_count_today?: number;
}

export interface IngestionSummary {
  sources_attempted: number;
  articles_fetched: number;
  new_articles: number;
  errors: number | any[];
}

// fast-xml-parser instance configured per Phase 3 specifications
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  allowBooleanAttributes: true,
  parseTagValue: true,
  trimValues: true,
  processEntities: true,
});

/**
 * Strips invalid XML control characters (retains tab \x09, LF \x0A, CR \x0D).
 */
function stripInvalidControlCharacters(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Normalizes text and computes its SHA-256 hash for deduplication.
 */
export function computeContentHash(text: string): string {
  const normalized = (text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Fetches with 30s timeout and exponential backoff retry (2 retries starting at 2 seconds).
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries = 2,
  baseDelayMs = 2000
): Promise<Response> {
  let attempt = 0;
  while (true) {
    try {
      return await safeFetch(url, options, { timeoutMs: 30_000 });
    } catch (err: unknown) {
      if (attempt >= maxRetries) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt++;
    }
  }
}

/**
 * Extracts string value safely from tag node which could be string, number, or object.
 */
function extractNodeText(node: unknown): string {
  if (!node) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj['#text']) return String(obj['#text']).trim();
    if (obj['@_href']) return String(obj['@_href']).trim();
  }
  return '';
}

/**
 * Fetches and parses an RSS feed using fast-xml-parser with control-character stripping fallback.
 */
export async function fetchRssFeed(source: { url: string; name?: string }): Promise<FeedItem[]> {
  const res = await fetchWithRetry(
    source.url,
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept:
          'application/rss+xml, application/xml, text/xml, application/atom+xml, text/html;q=0.9, */*;q=0.8',
      },
    },
    2,
    2000
  );

  if (!res.ok) {
    throw new Error(`Feed fetch failed with HTTP ${res.status}: ${res.statusText}`);
  }

  const rawText = await res.text();
  let parsed: any;

  try {
    parsed = xmlParser.parse(rawText);
  } catch (firstErr) {
    try {
      const sanitized = stripInvalidControlCharacters(rawText);
      parsed = xmlParser.parse(sanitized);
    } catch {
      // Parsing failed after fallback: log first 500 characters of raw response
      const snippet = rawText.slice(0, 500).replace(/\r?\n|\r/g, ' ');
      throw new Error(`XML parsing failed: ${snippet}`);
    }
  }

  // Locate items across RSS 2.0, Atom, or RDF structures
  let rawItems: any[] = [];
  if (parsed?.rss?.channel?.item) {
    const chItem = parsed.rss.channel.item;
    rawItems = Array.isArray(chItem) ? chItem : [chItem];
  } else if (parsed?.channel?.item) {
    const chItem = parsed.channel.item;
    rawItems = Array.isArray(chItem) ? chItem : [chItem];
  } else if (parsed?.feed?.entry) {
    const entries = parsed.feed.entry;
    rawItems = Array.isArray(entries) ? entries : [entries];
  } else if (parsed?.['rdf:RDF']?.item || parsed?.RDF?.item) {
    const items = parsed['rdf:RDF']?.item || parsed?.RDF?.item;
    rawItems = Array.isArray(items) ? items : [items];
  } else {
    // If not recognized as valid RSS/Atom/RDF, capture raw response preview
    const snippet = rawText.slice(0, 500).replace(/\r?\n|\r/g, ' ');
    throw new Error(`Feed does not contain recognizable RSS/Atom items. Raw preview: ${snippet}`);
  }

  return rawItems
    .map((item) => {
      const title = extractNodeText(item.title);
      let link = extractNodeText(item.link);
      if (!link && item.link && typeof item.link === 'object') {
        link = item.link['@_href'] || item.link['href'] || '';
      }
      if (!link && Array.isArray(item.link)) {
        const altLink = item.link.find((l: any) => l['@_rel'] === 'alternate' || l['@_href']);
        link = altLink?.['@_href'] || altLink?.['href'] || extractNodeText(item.link[0]);
      }

      const pubDate =
        extractNodeText(item.pubDate) ||
        extractNodeText(item.published) ||
        extractNodeText(item.updated) ||
        extractNodeText(item['dc:date']) ||
        null;

      const content =
        extractNodeText(item['content:encoded']) ||
        extractNodeText(item.content) ||
        extractNodeText(item.description) ||
        '';

      const summary =
        extractNodeText(item.description) ||
        extractNodeText(item.summary) ||
        content.slice(0, 300);

      return {
        title,
        link,
        pubDate,
        content,
        summary,
      };
    })
    .filter((item) => Boolean(item.link && item.title));
}

/**
 * Fetches JSON article items from an API source with 30s timeout and retries.
 */
export async function fetchApiFeed(source: { url: string; name?: string }): Promise<FeedItem[]> {
  const res = await fetchWithRetry(
    source.url,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json, */*',
      },
    },
    2,
    2000
  );

  if (!res.ok) {
    throw new Error(`API fetch failed with HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();
  const rawList = data.results || data.articles || data.data || [];

  return (rawList as any[])
    .map((item) => ({
      title: item.title || '',
      link: item.url || item.link || '',
      pubDate: item.published_at || item.publishedAt || item.pubDate || null,
      content: item.description || item.content || item.body || '',
      summary: item.description || item.summary || '',
    }))
    .filter((item) => Boolean(item.link && item.title));
}

/**
 * Extracts full text from an article URL using safeFetch, @mozilla/readability, and linkedom.
 * Falls back to feed summary if extraction fails.
 */
export async function extractFullText(url: string, fallbackSummary: string = ''): Promise<string> {
  try {
    const res = await safeFetch(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      },
      { timeoutMs: 30_000 }
    );

    if (!res.ok) {
      return fallbackSummary;
    }

    const html = await res.text();
    const { document } = parseHTML(html);
    const reader = new Readability(document);
    const article = reader.parse();

    if (article && article.textContent && article.textContent.trim().length > 50) {
      return article.textContent.trim();
    }
  } catch {
    // Graceful fallback to feed summary on network or parsing error
  }

  return fallbackSummary;
}

/**
 * Ingests a single source:
 * - Fetches RSS/API items
 * - Checks for duplicates in articles table by URL and content hash
 * - Extracts full text, computes content hash
 * - Inserts pending articles
 * - Updates source health and metadata
 */
export async function ingestSource(source: SourceConfig): Promise<{
  articles_fetched: number;
  new_articles: number;
  success: boolean;
  error?: string;
  response_time_ms: number;
}> {
  const startTime = Date.now();
  let articlesFetched = 0;
  let newArticles = 0;

  try {
    const items =
      source.type === 'api'
        ? await fetchApiFeed(source)
        : await fetchRssFeed(source);

    articlesFetched = items.length;
    const responseTimeMs = Date.now() - startTime;

    for (const item of items) {
      if (!item.link) continue;

      // Deduplication check by URL
      const { data: existingArticle } = await supabase
        .from('articles')
        .select('id')
        .eq('url', item.link)
        .maybeSingle();

      if (existingArticle) {
        continue;
      }

      // Extract full text using readability with fallback
      const fullText = await extractFullText(item.link, item.summary || item.content);
      const contentHash = computeContentHash(fullText || item.title);

      // Deduplication check by content hash
      const { data: existingByHash } = await supabase
        .from('articles')
        .select('id')
        .eq('content_hash', contentHash)
        .maybeSingle();

      if (existingByHash) {
        continue;
      }

      // Insert new pending article
      const { error: insertError } = await supabase.from('articles').insert({
        source_id: source.id || null,
        title: item.title,
        body: fullText,
        url: item.link,
        canonical_url: item.link,
        content_hash: contentHash,
        published_at: item.pubDate
          ? new Date(item.pubDate).toISOString()
          : new Date().toISOString(),
        status: 'pending',
        raw_json: item,
      });

      if (!insertError) {
        newArticles++;
      }
    }

    // Update source successful status and metrics
    if (source.id) {
      await supabase
        .from('sources')
        .update({
          last_fetch_at: new Date().toISOString(),
          last_success_at: new Date().toISOString(),
          article_count_today: (source.article_count_today || 0) + newArticles,
          response_time_ms: responseTimeMs,
          status: 'healthy',
        })
        .eq('id', source.id);

      // Record health entry
      await supabase.from('source_health').insert({
        source_id: source.id,
        check_at: new Date().toISOString(),
        articles_fetched: articlesFetched,
        success: true,
        response_time_ms: responseTimeMs,
      });
    }

    return {
      articles_fetched: articlesFetched,
      new_articles: newArticles,
      success: true,
      response_time_ms: responseTimeMs,
    };
  } catch (err: unknown) {
    const responseTimeMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Record health failure and evaluate consecutive failure count
    if (source.id) {
      await supabase.from('source_health').insert({
        source_id: source.id,
        check_at: new Date().toISOString(),
        articles_fetched: 0,
        success: false,
        error_message: errorMessage,
        response_time_ms: responseTimeMs,
      });

      // Check last 3 health records for consecutive failures
      const { data: recentHealth } = await supabase
        .from('source_health')
        .select('success')
        .eq('source_id', source.id)
        .order('check_at', { ascending: false })
        .limit(3);

      const consecutiveFailures = (recentHealth || []).every((r) => r.success === false);
      const newStatus =
        consecutiveFailures && (recentHealth?.length || 0) >= 3 ? 'error' : 'warning';

      await supabase
        .from('sources')
        .update({
          last_fetch_at: new Date().toISOString(),
          response_time_ms: responseTimeMs,
          status: newStatus,
        })
        .eq('id', source.id);
    }

    return {
      articles_fetched: 0,
      new_articles: 0,
      success: false,
      error: errorMessage,
      response_time_ms: responseTimeMs,
    };
  }
}

/**
 * Loads sources from config/sources.yaml, syncs with Supabase, and ingests all active sources
 * with concurrency capped at 3 via p-limit.
 */
export async function ingestAllSources(): Promise<IngestionSummary> {
  if (!(await isPipelineEnabled())) {
    console.warn('[Ingestion] Pipeline disabled. Skipping run.');
    return { sources_attempted: 0, articles_fetched: 0, new_articles: 0, errors: [] };
  }

  const configPath = path.resolve(process.cwd(), 'config/sources.yaml');
  let yamlSources: SourceConfig[] = [];

  if (fs.existsSync(configPath)) {
    const rawYaml = fs.readFileSync(configPath, 'utf8');
    const parsed = YAML.parse(rawYaml);
    if (parsed && Array.isArray(parsed.sources)) {
      yamlSources = parsed.sources;
    }
  }

  // Deactivate any sources in DB that are not in the new configuration
  const validUrls = yamlSources.map((s) => s.url);
  const { data: allDbSources } = await supabase.from('sources').select('id, url');
  for (const s of allDbSources || []) {
    if (!validUrls.includes(s.url)) {
      await supabase.from('sources').update({ active: false }).eq('id', s.id);
    }
  }

  // Ensure all YAML sources exist and are active in the database
  for (const s of yamlSources) {
    const { data: existing } = await supabase
      .from('sources')
      .select('id, active, status, article_count_today')
      .eq('url', s.url)
      .maybeSingle();

    if (!existing) {
      await supabase.from('sources').insert({
        name: s.name,
        type: s.type,
        url: s.url,
        region: s.region,
        active: true,
        status: 'healthy',
        article_count_today: 0,
      });
    } else {
      await supabase
        .from('sources')
        .update({
          name: s.name,
          type: s.type,
          region: s.region,
          active: true,
        })
        .eq('id', existing.id);
    }
  }

  // Query active sources from database
  const { data: dbSources, error: dbError } = await supabase
    .from('sources')
    .select('id, name, type, url, region, active, status, article_count_today')
    .eq('active', true);

  if (dbError) {
    throw new Error(`Failed to load active sources from database: ${dbError.message}`);
  }

  const sourcesToIngest: SourceConfig[] = dbSources || [];
  const limit = pLimit(3);

  let totalArticlesFetched = 0;
  let totalNewArticles = 0;
  let totalErrors = 0;

  const tasks = sourcesToIngest.map((src) =>
    limit(async () => {
      const result = await ingestSource(src);
      totalArticlesFetched += result.articles_fetched;
      totalNewArticles += result.new_articles;
      if (!result.success) {
        totalErrors++;
      }
    })
  );

  await Promise.all(tasks);

  return {
    sources_attempted: sourcesToIngest.length,
    articles_fetched: totalArticlesFetched,
    new_articles: totalNewArticles,
    errors: totalErrors,
  };
}
