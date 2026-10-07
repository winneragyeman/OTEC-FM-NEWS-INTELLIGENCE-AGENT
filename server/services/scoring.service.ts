import crypto from 'crypto';
import { GoogleGenAI, Type } from '@google/genai';
import { z } from 'zod';
import { supabase } from '../db/client.ts';
import { DatabaseError, ScoringFailedError, QuotaExceededError } from '../lib/errors.ts';
import { logUsage, checkDailyBudget } from '../lib/cost-tracker.ts';
import { checkAndIncrementQuota } from '../lib/quota-tracker.ts';
import { checkKeywords } from './keyword-backstop.service.ts';
import { sanitizeUntrustedInput } from './sanitizer.service.ts';
import { SCORING_SYSTEM_INSTRUCTION, SCORING_PROMPT_VERSION } from '../prompts/scoring.prompt.ts';

export const PROMPT_VERSION = SCORING_PROMPT_VERSION || 'v1.0';
export const DEFAULT_SCORING_MODEL = process.env.GEMINI_MODEL_SCORING || 'gemini-3.1-pro-preview';
export const DEFAULT_FALLBACK_MODEL = process.env.GEMINI_MODEL_FALLBACK || 'gemini-3.5-flash';

export const ScoringSchema = z.object({
  importance: z.number().int().min(0).max(10),
  locality: z.number().int().min(0).max(10),
  genre: z.enum(['Politics', 'Sports', 'Entertainment', 'Metro', 'Business', 'Crime', 'General']),
  event_type: z.string().max(50),
  scope: z.enum(['local', 'regional', 'national', 'foreign']),
  is_foreign: z.boolean(),
  sport_scope: z.enum(['local', 'major_intl', 'other']).nullable(),
  new_information: z.boolean(),
  sensitive_flags: z.array(z.string()),
  reasoning: z.string().max(500),
});

export type ValidatedScoreOutput = z.infer<typeof ScoringSchema>;

export interface ScoreRecord {
  id?: string;
  cluster_id: string;
  version: number;
  importance_score: number;
  locality_score: number;
  combined_score: number;
  genre: string;
  event_type: string;
  scope: string;
  foreign_relevance: boolean | null;
  developing_story: boolean;
  sensitive_content: boolean;
  sensitive_reasons: string[];
  credibility_status: string;
  reasoning: string;
  scoring_model: string;
  prompt_version: string;
  route: 'hold' | 'scored' | 'rejected';
  keyword_flags: string[];
  created_at?: string;
  [key: string]: unknown;
}

export interface ScoreResult {
  score: ScoreRecord;
  route: 'hold' | 'scored' | 'rejected';
  keyword_flags: string[];
}

/**
 * Calculates locality score with Ashanti / Kumasi +1 bonus (capped at 10).
 */
export function calculateLocalityWithBonus(rawLocality: number, locations?: unknown): number {
  let hasAshanti = false;
  if (Array.isArray(locations)) {
    hasAshanti = locations.some(
      (loc) => typeof loc === 'string' && /ashanti|kumasi/i.test(loc)
    );
  } else if (typeof locations === 'string') {
    hasAshanti = /ashanti|kumasi/i.test(locations);
  }

  return hasAshanti ? Math.min(10, rawLocality + 1) : rawLocality;
}

/**
 * Pure evaluation function for the routing decision table:
 * - If sensitive_content OR keyword_flags.length > 0 → 'hold'
 * - Else if is_foreign AND importance < 8 → 'rejected'
 * - Else if sport_scope == 'major_intl' AND importance < 7 → 'rejected'
 * - Else if sport_scope == 'local' AND importance >= 3 → 'scored'
 * - Else if importance >= 5 → 'scored'
 * - Else if importance >= 4 AND locality >= 6 → 'scored'
 * - Else if importance >= 3 AND locality >= 8 → 'scored'
 * - Else → 'rejected'
 */
export function evaluateRoute(params: {
  sensitive_content: boolean;
  keyword_flags: string[];
  is_foreign: boolean;
  sport_scope: 'local' | 'major_intl' | 'other' | string | null;
  importance: number;
  locality: number;
}): 'hold' | 'scored' | 'rejected' {
  const { sensitive_content, keyword_flags, is_foreign, sport_scope, importance, locality } = params;

  if (sensitive_content || (keyword_flags && keyword_flags.length > 0)) {
    return 'hold';
  }
  if (is_foreign && importance < 8) {
    return 'rejected';
  }
  if (sport_scope === 'major_intl' && importance < 7) {
    return 'rejected';
  }
  if (sport_scope === 'local' && importance >= 3) {
    return 'scored';
  }
  if (importance >= 5) {
    return 'scored';
  }
  if (importance >= 4 && locality >= 6) {
    return 'scored';
  }
  if (importance >= 3 && locality >= 8) {
    return 'scored';
  }
  return 'rejected';
}

const SINGLE_SCORE_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    importance: { type: Type.INTEGER, description: 'Scale 0-10' },
    locality: { type: Type.INTEGER, description: 'Scale 0-10' },
    genre: {
      type: Type.STRING,
      description: 'One of Politics, Sports, Entertainment, Metro, Business, Crime, General',
    },
    event_type: { type: Type.STRING, description: 'Event type string max 50 chars' },
    scope: {
      type: Type.STRING,
      description: 'One of local, regional, national, foreign',
    },
    is_foreign: { type: Type.BOOLEAN },
    sport_scope: {
      type: Type.STRING,
      description: 'One of local, major_intl, other, or null',
    },
    new_information: { type: Type.BOOLEAN },
    sensitive_flags: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    reasoning: { type: Type.STRING, description: 'Max 500 characters' },
  },
  required: [
    'importance',
    'locality',
    'genre',
    'event_type',
    'scope',
    'is_foreign',
    'new_information',
    'sensitive_flags',
    'reasoning',
  ],
};

/**
 * Scores a single cluster using LLM with keyword backstop, quota check, and routing table.
 */
export async function scoreCluster(
  clusterId: string,
  modelId: string = DEFAULT_SCORING_MODEL
): Promise<ScoreResult> {
  // Step a: Fetch cluster
  const { data: cluster, error: clusterError } = await supabase
    .from('clusters')
    .select('id, headline, combined_text, locations, source_diversity, unique_source_count, article_count, status, version')
    .eq('id', clusterId)
    .maybeSingle();

  if (clusterError) {
    throw new DatabaseError(`Failed to fetch cluster ${clusterId}: ${clusterError.message}`, clusterError);
  }
  if (!cluster) {
    throw new ScoringFailedError(`Cluster ${clusterId} not found`);
  }

  // Step b: Sanitize combined_text
  const rawStoryText = `${cluster.headline || ''}\n\n${cluster.combined_text || ''}`.trim();
  const sanitizedText = sanitizeUntrustedInput(rawStoryText);

  // Step c: Generate random delimiter via crypto.randomBytes(8).toString('hex')
  const delimiterToken = crypto.randomBytes(8).toString('hex');
  const delimiter = `===NEWS_STORY_${delimiterToken}===`;

  // Step d: Check keyword backstop FIRST
  const keywordResult = checkKeywords(rawStoryText);
  const keywordFlags = keywordResult.flags;

  // Step e: Check quota via checkAndIncrementQuota(modelId, 80)
  const quotaAllowed = await checkAndIncrementQuota(modelId, 80);
  if (!quotaAllowed) {
    throw new QuotaExceededError(`Daily quota of 80 calls exceeded for model ${modelId}`);
  }

  // Enforce daily cost budget cap before calling LLM
  await checkDailyBudget();

  // Step f & g: Build prompt and call Gemini with responseSchema
  const userPrompt = `${delimiter}\nHeadline: ${cluster.headline}\n\nStory Content:\n${sanitizedText}\n${delimiter}`;
  const ai = new GoogleGenAI();

  async function executeCall(): Promise<{ validated: ValidatedScoreOutput; promptTokens: number; outputTokens: number }> {
    const response = await ai.models.generateContent({
      model: modelId,
      contents: userPrompt,
      config: {
        systemInstruction: SCORING_SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: SINGLE_SCORE_RESPONSE_SCHEMA,
      },
    });

    const textOutput = response.text;
    if (!textOutput) {
      throw new ScoringFailedError('Empty response received from LLM');
    }

    const parsedJson = JSON.parse(textOutput);
    // Step h: Validate with Zod
    const validated = ScoringSchema.parse(parsedJson);

    const promptTokens = response.usageMetadata?.promptTokenCount || 0;
    const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;

    return { validated, promptTokens, outputTokens };
  }

  let callResult: { validated: ValidatedScoreOutput; promptTokens: number; outputTokens: number } | null = null;

  // Retry ONCE on failure. On second failure, throw ScoringFailedError (no fabricated score).
  try {
    callResult = await executeCall();
  } catch (firstErr) {
    try {
      callResult = await executeCall();
    } catch (secondErr) {
      throw new ScoringFailedError(
        `Scoring failed validation after retry: ${secondErr instanceof Error ? secondErr.message : String(secondErr)}`,
        secondErr
      );
    }
  }

  const { validated, promptTokens, outputTokens } = callResult;

  // Step i: Compute combined in code:
  // If locations includes 'Ashanti' or 'Kumasi', +1 to locality (cap 10)
  const localityScore = calculateLocalityWithBonus(validated.locality, cluster.locations);
  const combinedScore = (validated.importance + localityScore) / 2;

  // Step d & j: Sensitive content logic and routing table
  // LLM cannot lower sensitive_content if keywords matched
  const sensitiveContent = keywordResult.matched || (validated.sensitive_flags && validated.sensitive_flags.length > 0);
  const sensitiveReasons = Array.from(new Set([...keywordFlags, ...(validated.sensitive_flags || [])]));

  const route = evaluateRoute({
    sensitive_content: sensitiveContent,
    keyword_flags: keywordFlags,
    is_foreign: validated.is_foreign,
    sport_scope: validated.sport_scope,
    importance: validated.importance,
    locality: localityScore,
  });

  // Step k: Query max version + 1
  const { data: latestScore } = await supabase
    .from('scores')
    .select('version')
    .eq('cluster_id', clusterId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = (latestScore?.version ?? 0) + 1;

  const scoreRecord: ScoreRecord = {
    cluster_id: clusterId,
    version: nextVersion,
    importance_score: validated.importance,
    locality_score: localityScore,
    combined_score: combinedScore,
    genre: validated.genre,
    event_type: validated.event_type,
    scope: validated.scope,
    foreign_relevance: validated.is_foreign ? localityScore > 0 : null,
    developing_story: validated.new_information,
    sensitive_content: sensitiveContent,
    sensitive_reasons: sensitiveReasons,
    credibility_status: 'unverified',
    reasoning: validated.reasoning,
    scoring_model: modelId,
    prompt_version: PROMPT_VERSION,
    route,
    keyword_flags: keywordFlags,
    created_at: new Date().toISOString(),
  };

  const { data: insertedScore, error: insertError } = await supabase
    .from('scores')
    .insert(scoreRecord)
    .select('*')
    .single();

  if (insertError) {
    throw new DatabaseError(`Failed to save score record: ${insertError.message}`, insertError);
  }

  // Step l: Update cluster status based on route
  const { error: updateClusterError } = await supabase
    .from('clusters')
    .update({
      status: route,
      updated_at: new Date().toISOString(),
    })
    .eq('id', clusterId);

  if (updateClusterError) {
    console.warn(`[ScoringService] Failed to update cluster ${clusterId} status to ${route}:`, updateClusterError.message);
  }

  // Step m: Log tokens to llm_usage with task = 'scoring'
  const estimatedCostCents = ((promptTokens * 1.25 + outputTokens * 5.00) / 1_000_000) * 100;
  await logUsage(modelId, 'scoring', promptTokens, outputTokens, estimatedCostCents, clusterId);

  // Step n: Return { score, route, keyword_flags }
  return {
    score: (insertedScore as ScoreRecord) || scoreRecord,
    route,
    keyword_flags: keywordFlags,
  };
}

/**
 * Scores a batch of clusters in a single Gemini call.
 * Falls back to individual scoring on any failure or timeout.
 */
export async function scoreClusterBatch(
  clusterIds: string[],
  modelId: string = DEFAULT_SCORING_MODEL
): Promise<ScoreResult[]> {
  if (clusterIds.length === 0) {
    return [];
  }

  if (clusterIds.length === 1) {
    const single = await scoreCluster(clusterIds[0], modelId);
    return [single];
  }

  // Fetch all clusters
  const { data: clusters, error: clustersError } = await supabase
    .from('clusters')
    .select('id, headline, combined_text, locations, source_diversity, unique_source_count, article_count, status, version')
    .in('id', clusterIds);

  if (clustersError || !clusters || clusters.length === 0) {
    throw new DatabaseError(`Failed to fetch clusters for batch scoring: ${clustersError?.message}`);
  }

  // Ensure clusters are in the order of requested clusterIds
  const clusterMap = new Map<string, (typeof clusters)[0]>();
  for (const c of clusters) {
    clusterMap.set(c.id, c);
  }
  const orderedClusters = clusterIds.map((id) => clusterMap.get(id)).filter(Boolean) as typeof clusters;

  // Run keyword backstop for each cluster in memory
  const clusterKeywords = new Map<string, { matched: boolean; flags: string[] }>();
  for (const c of orderedClusters) {
    const raw = `${c.headline || ''}\n\n${c.combined_text || ''}`.trim();
    clusterKeywords.set(c.id, checkKeywords(raw));
  }

  // Check quota for the batch call
  const quotaAllowed = await checkAndIncrementQuota(modelId, 80);
  if (!quotaAllowed) {
    throw new QuotaExceededError(`Daily quota of 80 calls exceeded for model ${modelId}`);
  }

  await checkDailyBudget();

  // Build batch prompt
  const userStorySections = orderedClusters
    .map((c, index) => {
      const delimiterToken = crypto.randomBytes(8).toString('hex');
      const delimiter = `===NEWS_STORY_${delimiterToken}===`;
      const sanitized = sanitizeUntrustedInput(`${c.headline || ''}\n\n${c.combined_text || ''}`.trim());
      return `STORY ${index + 1} (ID: ${c.id}):\n${delimiter}\nHeadline: ${c.headline}\n\nStory Content:\n${sanitized}\n${delimiter}`;
    })
    .join('\n\n----------------------------------------\n\n');

  const batchSystemInstruction = `${SCORING_SYSTEM_INSTRUCTION}\nYou will receive ${orderedClusters.length} stories. Return an array of ${orderedClusters.length} score objects in the exact same order.`;

  const ai = new GoogleGenAI();

  let batchResponseData: unknown[] | null = null;
  let promptTokens = 0;
  let outputTokens = 0;

  try {
    // 30-second timeout for batch call
    const callPromise = ai.models.generateContent({
      model: modelId,
      contents: userStorySections,
      config: {
        systemInstruction: batchSystemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: SINGLE_SCORE_RESPONSE_SCHEMA,
        },
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Batch scoring call timed out after 30 seconds')), 30000)
    );

    const response = await Promise.race([callPromise, timeoutPromise]);
    promptTokens = response.usageMetadata?.promptTokenCount || 0;
    outputTokens = response.usageMetadata?.candidatesTokenCount || 0;

    const textOutput = response.text;
    if (textOutput) {
      const parsed = JSON.parse(textOutput);
      if (Array.isArray(parsed) && parsed.length === orderedClusters.length) {
        batchResponseData = parsed;
      }
    }
  } catch (batchErr) {
    console.warn(`[ScoringService] Batch call failed or timed out (${batchErr instanceof Error ? batchErr.message : String(batchErr)}). Falling back to individual scoring.`);
  }

  // If batch call completely failed or returned invalid array length, fallback all clusters individually
  if (!batchResponseData) {
    const results: ScoreResult[] = [];
    for (const c of orderedClusters) {
      const singleRes = await scoreCluster(c.id, modelId);
      results.push(singleRes);
    }
    return results;
  }

  // Process each cluster from the batch response
  const finalResults: ScoreResult[] = [];

  for (let i = 0; i < orderedClusters.length; i++) {
    const c = orderedClusters[i];
    const rawItem = batchResponseData[i];

    let validated: ValidatedScoreOutput | null = null;
    try {
      validated = ScoringSchema.parse(rawItem);
    } catch (valErr) {
      console.warn(`[ScoringService] Validation failed for cluster ${c.id} in batch, falling back to individual scoring:`, valErr);
    }

    // On single cluster validation failure, fall back to scoring that cluster individually
    if (!validated) {
      const individualResult = await scoreCluster(c.id, modelId);
      finalResults.push(individualResult);
      continue;
    }

    const keywordInfo = clusterKeywords.get(c.id) || { matched: false, flags: [] };
    const keywordFlags = keywordInfo.flags;
    const localityScore = calculateLocalityWithBonus(validated.locality, c.locations);
    const combinedScore = (validated.importance + localityScore) / 2;

    const sensitiveContent = keywordInfo.matched || (validated.sensitive_flags && validated.sensitive_flags.length > 0);
    const sensitiveReasons = Array.from(new Set([...keywordFlags, ...(validated.sensitive_flags || [])]));

    const route = evaluateRoute({
      sensitive_content: sensitiveContent,
      keyword_flags: keywordFlags,
      is_foreign: validated.is_foreign,
      sport_scope: validated.sport_scope,
      importance: validated.importance,
      locality: localityScore,
    });

    const { data: latestScore } = await supabase
      .from('scores')
      .select('version')
      .eq('cluster_id', c.id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextVersion = (latestScore?.version ?? 0) + 1;

    const scoreRecord: ScoreRecord = {
      cluster_id: c.id,
      version: nextVersion,
      importance_score: validated.importance,
      locality_score: localityScore,
      combined_score: combinedScore,
      genre: validated.genre,
      event_type: validated.event_type,
      scope: validated.scope,
      foreign_relevance: validated.is_foreign ? localityScore > 0 : null,
      developing_story: validated.new_information,
      sensitive_content: sensitiveContent,
      sensitive_reasons: sensitiveReasons,
      credibility_status: 'unverified',
      reasoning: validated.reasoning,
      scoring_model: modelId,
      prompt_version: PROMPT_VERSION,
      route,
      keyword_flags: keywordFlags,
      created_at: new Date().toISOString(),
    };

    const { data: inserted, error: insertError } = await supabase
      .from('scores')
      .insert(scoreRecord)
      .select('*')
      .single();

    if (insertError) {
      throw new DatabaseError(`Failed to save score for cluster ${c.id}: ${insertError.message}`, insertError);
    }

    await supabase
      .from('clusters')
      .update({
        status: route,
        updated_at: new Date().toISOString(),
      })
      .eq('id', c.id);

    finalResults.push({
      score: (inserted as ScoreRecord) || scoreRecord,
      route,
      keyword_flags: keywordFlags,
    });
  }

  // Log tokens for the batch call
  if (promptTokens > 0 || outputTokens > 0) {
    const estimatedCostCents = ((promptTokens * 1.25 + outputTokens * 5.00) / 1_000_000) * 100;
    await logUsage(modelId, 'scoring', promptTokens, outputTokens, estimatedCostCents, null);
  }

  return finalResults;
}
