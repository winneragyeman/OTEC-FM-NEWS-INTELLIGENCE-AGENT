import { supabase } from '../db/client.ts';

/**
 * Retrieves a numeric configuration value from pipeline_config, falling back to defaultValue.
 */
export async function getPipelineConfigNumber(key: string, defaultValue: number): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('pipeline_config')
      .select('value')
      .eq('key', key)
      .maybeSingle();

    if (error || !data) {
      return defaultValue;
    }

    const parsed = Number(data.value);
    return isNaN(parsed) ? defaultValue : parsed;
  } catch {
    return defaultValue;
  }
}

/**
 * Checks whether the specified model has calls remaining against its daily limit.
 * If under the limit, increments calls_today and returns true.
 * If calls_today >= dailyLimit, returns false without incrementing.
 * Automatically resets calls_today if last_reset is earlier than the current UTC/local date.
 */
export async function checkAndIncrementQuota(
  modelId: string,
  dailyLimit: number = 80
): Promise<boolean> {
  const todayStr = new Date().toISOString().slice(0, 10);

  // 1. Fetch current record
  const { data: record, error: fetchError } = await supabase
    .from('model_quota_tracking')
    .select('model_id, calls_today, last_reset')
    .eq('model_id', modelId)
    .maybeSingle();

  if (fetchError && fetchError.code !== 'PGRST116') {
    console.warn(`[QuotaTracker] Error reading quota for ${modelId}:`, fetchError.message);
  }

  let callsToday = record ? (record.calls_today ?? 0) : 0;
  const lastReset = record?.last_reset ? String(record.last_reset).slice(0, 10) : todayStr;

  // 2. Reset if from an earlier day or missing
  if (!record || lastReset < todayStr) {
    callsToday = 0;
  }

  // 3. Quota exceeded check
  if (callsToday >= dailyLimit) {
    return false;
  }

  // 4. Increment and save
  const newCallsToday = callsToday + 1;
  const { error: upsertError } = await supabase
    .from('model_quota_tracking')
    .upsert({
      model_id: modelId,
      calls_today: newCallsToday,
      last_reset: todayStr,
      updated_at: new Date().toISOString(),
    });

  if (upsertError) {
    console.warn(`[QuotaTracker] Upsert warning for ${modelId}:`, upsertError.message);
  }

  return true;
}

/**
 * Returns current quota usage and remaining allowance for the specified model.
 */
export async function getQuotaStatus(
  modelId: string,
  customDailyLimit?: number
): Promise<{ calls_today: number; daily_limit: number; remaining: number }> {
  const dailyLimit =
    customDailyLimit ??
    (await getPipelineConfigNumber('scoring_daily_limit', 80));

  const todayStr = new Date().toISOString().slice(0, 10);

  const { data: record } = await supabase
    .from('model_quota_tracking')
    .select('calls_today, last_reset')
    .eq('model_id', modelId)
    .maybeSingle();

  let callsToday = record ? (record.calls_today ?? 0) : 0;
  const lastReset = record?.last_reset ? String(record.last_reset).slice(0, 10) : todayStr;

  if (lastReset < todayStr) {
    callsToday = 0;
  }

  const remaining = Math.max(0, dailyLimit - callsToday);

  return {
    calls_today: callsToday,
    daily_limit: dailyLimit,
    remaining,
  };
}
