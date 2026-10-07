import { supabase } from './client.ts';
import { DatabaseError } from '../lib/errors.ts';

export interface SourceRecord {
  id?: string;
  name: string;
  url: string;
  feed_url?: string | null;
  source_type: string;
  is_active: boolean;
  fetch_interval_minutes?: number;
  last_fetched_at?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export async function getActiveSources(): Promise<SourceRecord[]> {
  const { data, error } = await supabase
    .from('sources')
    .select('*')
    .eq('is_active', true);

  if (error) {
    throw new DatabaseError(`Failed to fetch active sources: ${error.message}`, error);
  }
  return (data as SourceRecord[]) || [];
}

export async function getSourceById(id: string): Promise<SourceRecord | null> {
  const { data, error } = await supabase
    .from('sources')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new DatabaseError(`Failed to fetch source ${id}: ${error.message}`, error);
  }
  return data as SourceRecord;
}

export async function createSource(data: Partial<SourceRecord>): Promise<SourceRecord> {
  const { data: created, error } = await supabase
    .from('sources')
    .insert(data)
    .select('*')
    .single();

  if (error) {
    throw new DatabaseError(`Failed to create source: ${error.message}`, error);
  }
  return created as SourceRecord;
}

export async function updateSource(id: string, data: Partial<SourceRecord>): Promise<SourceRecord> {
  const { data: updated, error } = await supabase
    .from('sources')
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    throw new DatabaseError(`Failed to update source ${id}: ${error.message}`, error);
  }
  return updated as SourceRecord;
}

export async function toggleSource(id: string): Promise<SourceRecord> {
  const source = await getSourceById(id);
  if (!source) {
    throw new DatabaseError(`Source with id ${id} not found`);
  }

  return updateSource(id, { is_active: !source.is_active });
}
