import { supabase } from './client.ts';
import { DatabaseError } from '../lib/errors.ts';

export interface ClusterRecord {
  id?: string;
  title: string;
  summary?: string | null;
  status: string;
  version: number;
  article_count?: number;
  category?: string | null;
  locality?: number | null;
  importance?: number | null;
  is_foreign?: boolean;
  sport_scope?: string | null;
  sensitive_flags?: string[] | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export async function createCluster(data: Partial<ClusterRecord>): Promise<ClusterRecord> {
  const { data: created, error } = await supabase
    .from('clusters')
    .insert({
      version: 1,
      ...data,
    })
    .select('*')
    .single();

  if (error) {
    throw new DatabaseError(`Failed to create cluster: ${error.message}`, error);
  }
  return created as ClusterRecord;
}

export async function getClusterById(id: string): Promise<ClusterRecord | null> {
  const { data, error } = await supabase
    .from('clusters')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new DatabaseError(`Failed to get cluster ${id}: ${error.message}`, error);
  }
  return data as ClusterRecord;
}

export async function getClustersByStatus(status: string): Promise<ClusterRecord[]> {
  const { data, error } = await supabase
    .from('clusters')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: false });

  if (error) {
    throw new DatabaseError(`Failed to fetch clusters with status ${status}: ${error.message}`, error);
  }
  return (data as ClusterRecord[]) || [];
}

export async function updateClusterStatus(
  id: string,
  status: string,
  version: number
): Promise<ClusterRecord> {
  const { data: updated, error } = await supabase
    .from('clusters')
    .update({
      status,
      version: version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('version', version)
    .select('*')
    .single();

  if (error) {
    throw new DatabaseError(
      `Failed to update cluster ${id} status to ${status} (expected version ${version}): ${error.message}`,
      error
    );
  }
  return updated as ClusterRecord;
}
