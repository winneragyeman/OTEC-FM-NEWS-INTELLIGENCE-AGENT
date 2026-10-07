import { supabase } from './client.ts';
import { DatabaseError } from '../lib/errors.ts';

export interface DecisionRecord {
  id?: string;
  cluster_id: string;
  editor_id: string;
  action: 'approve' | 'reject' | 'hold' | 'discard' | string;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  [key: string]: unknown;
}

export async function insertDecision(data: DecisionRecord): Promise<DecisionRecord> {
  // If decide_cluster RPC is present in database, invoke it; otherwise insert into append-only table
  try {
    const { data: rpcResult, error: rpcError } = await supabase.rpc('decide_cluster', {
      p_cluster_id: data.cluster_id,
      p_editor_id: data.editor_id,
      p_action: data.action,
      p_notes: data.notes || null,
      p_metadata: data.metadata || null,
    });

    if (!rpcError && rpcResult) {
      return rpcResult as DecisionRecord;
    }
  } catch {
    // Fall back to append-only insert
  }

  const { data: created, error } = await supabase
    .from('decisions')
    .insert(data)
    .select('*')
    .single();

  if (error) {
    throw new DatabaseError(`Failed to insert decision: ${error.message}`, error);
  }
  return created as DecisionRecord;
}

export async function getDecisionsByCluster(clusterId: string): Promise<DecisionRecord[]> {
  const { data, error } = await supabase
    .from('decisions')
    .select('*')
    .eq('cluster_id', clusterId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new DatabaseError(
      `Failed to fetch decisions for cluster ${clusterId}: ${error.message}`,
      error
    );
  }
  return (data as DecisionRecord[]) || [];
}
