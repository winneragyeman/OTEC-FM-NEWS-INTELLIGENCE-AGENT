import { supabase } from '../db/client.ts';

export interface SystemFlagsRecord {
  pipeline_enabled: boolean;
  updated_at: string;
  updated_by: string | null;
  reason: string | null;
}

/**
 * Checks whether the ingestion and clustering pipeline is currently enabled.
 * Defaults to true if the record is missing or on transient DB errors.
 */
export async function isPipelineEnabled(): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('system_flags')
      .select('pipeline_enabled')
      .eq('id', 1)
      .maybeSingle();

    if (error) {
      console.warn('[SystemFlags] Error fetching system flags, defaulting to enabled:', error.message);
      return true;
    }

    if (!data) {
      return true;
    }

    return Boolean(data.pipeline_enabled);
  } catch (err) {
    console.warn('[SystemFlags] Unexpected error in isPipelineEnabled, defaulting to enabled:', err);
    return true;
  }
}

/**
 * Disables the pipeline with a reason and editor identifier.
 */
export async function disablePipeline(reason: string, updatedBy: string): Promise<void> {
  const { error } = await supabase
    .from('system_flags')
    .upsert({
      id: 1,
      pipeline_enabled: false,
      reason,
      updated_by: updatedBy,
      updated_at: new Date().toISOString(),
    });

  if (error) {
    throw new Error(`Failed to disable pipeline: ${error.message}`);
  }
}

/**
 * Enables the pipeline with a reason and editor identifier.
 */
export async function enablePipeline(reason: string, updatedBy: string): Promise<void> {
  const { error } = await supabase
    .from('system_flags')
    .upsert({
      id: 1,
      pipeline_enabled: true,
      reason,
      updated_by: updatedBy,
      updated_at: new Date().toISOString(),
    });

  if (error) {
    throw new Error(`Failed to enable pipeline: ${error.message}`);
  }
}

/**
 * Retrieves the current system flags status.
 */
export async function getSystemFlags(): Promise<{
  pipeline_enabled: boolean;
  updated_at: string;
  updated_by: string | null;
  reason: string | null;
}> {
  const { data, error } = await supabase
    .from('system_flags')
    .select('pipeline_enabled, updated_at, updated_by, reason')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to get system flags: ${error.message}`);
  }

  if (!data) {
    return {
      pipeline_enabled: true,
      updated_at: new Date().toISOString(),
      updated_by: null,
      reason: null,
    };
  }

  return {
    pipeline_enabled: Boolean(data.pipeline_enabled),
    updated_at: data.updated_at || new Date().toISOString(),
    updated_by: data.updated_by ?? null,
    reason: data.reason ?? null,
  };
}
