import { supabase } from './client.ts';
import { DatabaseError } from '../lib/errors.ts';

export interface ArticleRecord {
  id?: string;
  source_id?: string;
  title: string;
  url: string;
  author?: string | null;
  published_at?: string | null;
  content?: string | null;
  summary?: string | null;
  status?: string;
  raw_payload?: Record<string, unknown> | null;
  cluster_id?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export async function insertArticle(data: Partial<ArticleRecord>): Promise<ArticleRecord> {
  const { data: created, error } = await supabase
    .from('articles')
    .insert(data)
    .select('*')
    .single();

  if (error) {
    throw new DatabaseError(`Failed to insert article: ${error.message}`, error);
  }
  return created as ArticleRecord;
}

export async function getArticleByUrl(url: string): Promise<ArticleRecord | null> {
  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .eq('url', url)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new DatabaseError(`Failed to fetch article by url: ${error.message}`, error);
  }
  return data as ArticleRecord;
}

export async function getPendingArticles(limit: number = 50): Promise<ArticleRecord[]> {
  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new DatabaseError(`Failed to fetch pending articles: ${error.message}`, error);
  }
  return (data as ArticleRecord[]) || [];
}

export async function updateArticleStatus(id: string, status: string): Promise<ArticleRecord> {
  const { data: updated, error } = await supabase
    .from('articles')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    throw new DatabaseError(`Failed to update status for article ${id}: ${error.message}`, error);
  }
  return updated as ArticleRecord;
}
