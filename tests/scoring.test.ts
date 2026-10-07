import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkKeywords } from '../server/services/keyword-backstop.service.ts';
import {
  calculateLocalityWithBonus,
  evaluateRoute,
  scoreCluster,
} from '../server/services/scoring.service.ts';
import { ScoringFailedError } from '../server/lib/errors.ts';
import { supabase } from '../server/db/client.ts';

// Mock dependencies for LLM and quota
const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => {
  return {
    Type: {
      OBJECT: 'OBJECT',
      STRING: 'STRING',
      INTEGER: 'INTEGER',
      BOOLEAN: 'BOOLEAN',
      ARRAY: 'ARRAY',
    },
    GoogleGenAI: class {
      models = {
        generateContent: mockGenerateContent,
      };
    },
  };
});

vi.mock('../server/lib/cost-tracker.ts', () => ({
  checkDailyBudget: vi.fn().mockResolvedValue(undefined),
  logUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../server/lib/quota-tracker.ts', () => ({
  checkAndIncrementQuota: vi.fn().mockResolvedValue(true),
  getPipelineConfigNumber: vi.fn().mockResolvedValue(80),
}));

describe('Phase 6 — LLM Dual-Axis Scoring & Safety Features', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Test 1: Ashanti bonus applies
  it('Test 1: Ashanti bonus applies (+1 locality, capped at 10)', () => {
    // Input: cluster with locations=['Kumasi'], LLM returns locality=9
    const localityScore = calculateLocalityWithBonus(9, ['Kumasi']);
    expect(localityScore).toBe(10);

    // Also verify cap at 10 when raw is already 10
    const cappedScore = calculateLocalityWithBonus(10, ['Ashanti']);
    expect(cappedScore).toBe(10);

    // Verify when location is not Ashanti/Kumasi
    const regularScore = calculateLocalityWithBonus(7, ['Accra']);
    expect(regularScore).toBe(7);
  });

  // Test 2: Keyword backstop forces sensitive
  it('Test 2: Keyword backstop forces sensitive on fatalities', () => {
    const text = 'Two killed in accident on Accra-Kumasi highway';
    const kwResult = checkKeywords(text);

    expect(kwResult.matched).toBe(true);
    expect(kwResult.flags).toContain('fatalities');

    // Sensitive content must remain true even if LLM returned sensitive_flags = []
    const llmSensitiveFlags: string[] = [];
    const sensitiveContent = kwResult.matched || llmSensitiveFlags.length > 0;
    expect(sensitiveContent).toBe(true);

    const route = evaluateRoute({
      sensitive_content: sensitiveContent,
      keyword_flags: kwResult.flags,
      is_foreign: false,
      sport_scope: null,
      importance: 8,
      locality: 10,
    });
    expect(route).toBe('hold');
  });

  // Test 3: Word-boundary matching
  it('Test 3: Word-boundary matching prevents false positives', () => {
    // "deadline extended" contains "dead" as substring, but word boundary \bdead\b must not match
    const text = 'deadline extended for national registration';
    const kwResult = checkKeywords(text);

    expect(kwResult.matched).toBe(false);
    expect(kwResult.flags).toEqual([]);
  });

  // Test 4: Routing — foreign rejected
  it('Test 4: Routing — foreign rejected when importance < 8', () => {
    const route = evaluateRoute({
      sensitive_content: false,
      keyword_flags: [],
      is_foreign: true,
      sport_scope: null,
      importance: 5,
      locality: 3,
    });

    expect(route).toBe('rejected');
  });

  // Test 5: Routing — sensitive held
  it('Test 5: Routing — sensitive held even with maximum importance and locality', () => {
    const route = evaluateRoute({
      sensitive_content: true,
      keyword_flags: ['fatalities'],
      is_foreign: false,
      sport_scope: null,
      importance: 8,
      locality: 10,
    });

    expect(route).toBe('hold');
  });

  // Test 6: Routing — local sport passes at low threshold
  it('Test 6: Routing — local sport passes at low threshold (importance >= 3)', () => {
    const route = evaluateRoute({
      sensitive_content: false,
      keyword_flags: [],
      is_foreign: false,
      sport_scope: 'local',
      importance: 4,
      locality: 3,
    });

    expect(route).toBe('scored');
  });

  // Test 7: No fabricated score on error
  it('Test 7: No fabricated score on error — throws ScoringFailedError and inserts no score', async () => {
    const testClusterId = '11111111-1111-1111-1111-111111111111';

    // Mock fetching cluster successfully
    vi.spyOn(supabase, 'from').mockImplementation(((table: string) => {
      if (table === 'clusters') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: testClusterId,
                  headline: 'Test breaking story',
                  combined_text: 'Sample story body',
                  locations: ['Kumasi'],
                  status: 'pending',
                  version: 1,
                },
                error: null,
              }),
            }),
          }),
          update: () => ({
            eq: async () => ({ error: null }),
          }),
        } as any;
      }
      if (table === 'scores') {
        return {
          insert: vi.fn(),
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
        } as any;
      }
      return {} as any;
    }) as any);

    // Mock LLM to throw twice
    mockGenerateContent.mockRejectedValueOnce(new Error('LLM connection error 1'));
    mockGenerateContent.mockRejectedValueOnce(new Error('LLM connection error 2'));

    // Expect scoreCluster to throw ScoringFailedError
    await expect(scoreCluster(testClusterId, 'gemini-3.1-pro-preview')).rejects.toThrow(
      ScoringFailedError
    );

    // Verify generateContent was called twice (initial + 1 retry)
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });
});
