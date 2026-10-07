import crypto from 'crypto';
import { GoogleGenAI, Type } from '@google/genai';
import { z } from 'zod';
import { supabase } from '../db/client.ts';
import { getClusterById } from '../db/clusters.repo.ts';
import { DatabaseError, ScoringFailedError } from '../lib/errors.ts';
import { logUsage, checkDailyBudget } from '../lib/cost-tracker.ts';
import { sanitizeUntrustedInput } from './sanitizer.service.ts';
import { EDITORIAL_SYSTEM_INSTRUCTION, EDITORIAL_PROMPT_VERSION } from '../prompts/editorial.prompt.ts';

const PROMPT_VERSION = EDITORIAL_PROMPT_VERSION || 'v1.0';

export const EditorialOutputSchema = z.object({
  web_headline: z.string().min(1),
  social_hook: z.string().min(1),
  body_copy: z.string().min(1),
  hashtags: z.array(z.string()),
  source_attribution: z.string().min(1),
});

export type EditorialOutput = z.infer<typeof EditorialOutputSchema>;

export interface EditorialPackage extends EditorialOutput {
  id?: string;
  cluster_id: string;
  version: number;
  model_id: string;
  prompt_version: string;
  created_at?: string;
}

export async function generateEditorial(clusterId: string): Promise<EditorialPackage> {
  const modelId = process.env.GEMINI_MODEL_EDITORIAL;
  if (!modelId) {
    throw new ScoringFailedError('GEMINI_MODEL_EDITORIAL environment variable is not set');
  }

  // Step 1: Fetch cluster and articles from Supabase
  const cluster = await getClusterById(clusterId);
  if (!cluster) {
    throw new ScoringFailedError(`Cluster ${clusterId} not found in database`);
  }

  const { data: articles, error: articlesError } = await supabase
    .from('articles')
    .select('title, content, summary')
    .eq('cluster_id', clusterId);

  if (articlesError) {
    throw new DatabaseError(`Failed to fetch articles for cluster ${clusterId}: ${articlesError.message}`);
  }

  const articlesText = (articles || [])
    .map((a, i) => `Article ${i + 1}: ${a.title}\n${a.summary || ''}\n${a.content || ''}`)
    .join('\n\n');

  const rawInput = `Station: OTEC FM 102.9 MHz (Kumasi, Ghana)\nCluster Title: ${cluster.title}\nCluster Summary: ${cluster.summary || ''}\n\nArticles:\n${articlesText}`;

  // Step 2: Sanitize input
  const sanitizedText = sanitizeUntrustedInput(rawInput);

  // Enforce daily budget cap before calling LLM
  await checkDailyBudget();

  // Initialize Gemini SDK
  const ai = new GoogleGenAI();
  const activeModelId: string = modelId;

  async function executeEditorialCall(): Promise<{ raw: EditorialOutput; promptTokens: number; outputTokens: number }> {
    // Step 3: Per-request random delimiter
    const delimiter = `===EDITORIAL_INPUT_${crypto.randomUUID()}===`;
    const prompt = `${delimiter}\n${sanitizedText}\n${delimiter}`;

    // Step 4 & 5: Call Gemini with structured output schema
    const response = await ai.models.generateContent({
      model: activeModelId,
      contents: prompt,
      config: {
        systemInstruction: EDITORIAL_SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            web_headline: { type: Type.STRING, description: '10-12 words, punchy, direct' },
            social_hook: {
              type: Type.STRING,
              description: '1-2 sentences engaging Facebook caption',
            },
            body_copy: {
              type: Type.STRING,
              description: 'Short neutral briefing of 40-80 words',
            },
            hashtags: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: '3-5 tags including #GhanaNews, #OTECFM',
            },
            source_attribution: { type: Type.STRING, description: 'Primary source outlet name' },
          },
          required: ['web_headline', 'social_hook', 'body_copy', 'hashtags', 'source_attribution'],
        },
      },
    });

    const textOutput = response.text;
    if (!textOutput) {
      throw new ScoringFailedError('Empty response received from LLM for editorial generation');
    }

    const parsedJson = JSON.parse(textOutput);
    // Step 6: Validate with Zod schema
    const validated = EditorialOutputSchema.parse(parsedJson);

    const promptTokens = response.usageMetadata?.promptTokenCount || 0;
    const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;

    return { raw: validated, promptTokens, outputTokens };
  }

  let editorialResult: { raw: EditorialOutput; promptTokens: number; outputTokens: number } | null = null;

  // Step 7 & 8: Retry ONCE on failure, throw on second failure
  try {
    editorialResult = await executeEditorialCall();
  } catch (firstErr) {
    try {
      editorialResult = await executeEditorialCall();
    } catch (secondErr) {
      throw new ScoringFailedError(
        `Editorial generation failed validation after retry: ${secondErr instanceof Error ? secondErr.message : String(secondErr)}`,
        secondErr
      );
    }
  }

  const { raw, promptTokens, outputTokens } = editorialResult;

  // Determine latest version for cluster in editorial_packages
  const { data: existingPackages } = await supabase
    .from('editorial_packages')
    .select('version')
    .eq('cluster_id', clusterId)
    .order('version', { ascending: false })
    .limit(1);

  const nextVersion = (existingPackages?.[0]?.version || 0) + 1;

  // Insert into editorial_packages
  const packagePayload = {
    cluster_id: clusterId,
    version: nextVersion,
    web_headline: raw.web_headline,
    social_hook: raw.social_hook,
    body_copy: raw.body_copy,
    hashtags: raw.hashtags,
    source_attribution: raw.source_attribution,
    model_id: modelId,
    prompt_version: PROMPT_VERSION,
    created_at: new Date().toISOString(),
  };

  const { data: insertedPackage, error: insertError } = await supabase
    .from('editorial_packages')
    .insert(packagePayload)
    .select('*')
    .single();

  if (insertError) {
    throw new DatabaseError(`Failed to save editorial package: ${insertError.message}`, insertError);
  }

  // Log usage to llm_usage
  // Flash pricing estimation: $0.10/1M in, $0.40/1M out -> cents calculation
  const estimatedCostCents = ((promptTokens * 0.10 + outputTokens * 0.40) / 1_000_000) * 100;
  await logUsage(modelId, 'editorial', promptTokens, outputTokens, estimatedCostCents, clusterId);

  return insertedPackage as EditorialPackage;
}
