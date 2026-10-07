import { supabase } from '../db/client.ts';
import { BudgetExceededError, DatabaseError } from './errors.ts';

export async function checkDailyBudget(): Promise<void> {
  const dailyBudgetCents = Number(process.env.LLM_DAILY_BUDGET_CENTS) || 200; // $2.00 default

  // Calculate start of current UTC day
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayIso = today.toISOString();

  // Query sum of estimated_cost_cents for today from Supabase
  const { data: usageRecords, error: fetchError } = await supabase
    .from('llm_usage')
    .select('estimated_cost_cents')
    .gte('created_at', todayIso);

  if (fetchError) {
    throw new DatabaseError(`Failed to fetch daily LLM usage: ${fetchError.message}`, fetchError);
  }

  const currentDailySpent = (usageRecords || []).reduce(
    (sum, record) => sum + (Number(record.estimated_cost_cents) || 0),
    0
  );

  if (currentDailySpent >= dailyBudgetCents) {
    throw new BudgetExceededError(
      `Daily LLM budget cap of ${dailyBudgetCents} cents exceeded. Current spent: ${currentDailySpent.toFixed(2)} cents.`
    );
  }
}

export async function logUsage(
  modelId: string,
  task: string,
  promptTokens: number,
  outputTokens: number,
  estimatedCostCents: number,
  clusterId?: string | null
): Promise<void> {
  const dailyBudgetCents = Number(process.env.LLM_DAILY_BUDGET_CENTS) || 200; // $2.00 default

  // Calculate start of current UTC day
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayIso = today.toISOString();

  // Query sum of estimated_cost_cents for today from Supabase
  const { data: usageRecords, error: fetchError } = await supabase
    .from('llm_usage')
    .select('estimated_cost_cents')
    .gte('created_at', todayIso);

  if (fetchError) {
    throw new DatabaseError(`Failed to fetch daily LLM usage: ${fetchError.message}`, fetchError);
  }

  const currentDailySpent = (usageRecords || []).reduce(
    (sum, record) => sum + (Number(record.estimated_cost_cents) || 0),
    0
  );

  if (currentDailySpent + estimatedCostCents > dailyBudgetCents) {
    throw new BudgetExceededError(
      `Daily LLM budget cap of ${dailyBudgetCents} cents reached. Spent: ${currentDailySpent.toFixed(2)} cents, attempted addition: ${estimatedCostCents.toFixed(2)} cents.`
    );
  }

  const { error: insertError } = await supabase
    .from('llm_usage')
    .insert({
      model_id: modelId,
      task,
      prompt_tokens: promptTokens,
      output_tokens: outputTokens,
      estimated_cost_cents: estimatedCostCents,
      cluster_id: clusterId || null,
      created_at: new Date().toISOString(),
    });

  if (insertError) {
    throw new DatabaseError(`Failed to log LLM usage: ${insertError.message}`, insertError);
  }
}
