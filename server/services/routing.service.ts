export interface RawScoreInput {
  importance: number;
  locality: number;
  is_ashanti?: boolean;
  is_foreign?: boolean;
  sport_scope?: 'major_intl' | 'local' | 'none' | string | null;
  sensitive_flags?: string[] | null;
  [key: string]: unknown;
}

export interface ComputedScoreResult {
  importance: number;
  locality: number;
  combined: number;
  route: 'editorial' | 'discard' | 'hold';
  sensitive: boolean;
}

export function computeScore(raw: RawScoreInput): ComputedScoreResult {
  const baseImportance = Math.max(0, Math.min(10, Math.round(Number(raw.importance) || 0)));
  let baseLocality = Math.max(0, Math.min(10, Math.round(Number(raw.locality) || 0)));

  // Apply Ashanti +1 locality bonus (cap at 10)
  if (raw.is_ashanti) {
    baseLocality = Math.min(10, baseLocality + 1);
  }

  const sensitiveFlags = Array.isArray(raw.sensitive_flags) ? raw.sensitive_flags : [];
  const sensitive = sensitiveFlags.length > 0;

  let route: 'editorial' | 'discard' | 'hold';

  // Sensitive check overrides route to 'hold'
  if (sensitive) {
    route = 'hold';
  } else if (raw.is_foreign) {
    // Foreign (is_foreign=true): editorial if importance >= 8, else discard
    route = baseImportance >= 8 ? 'editorial' : 'discard';
  } else if (raw.sport_scope === 'major_intl') {
    // Major international sport (sport_scope='major_intl'): editorial if importance >= 7, else discard
    route = baseImportance >= 7 ? 'editorial' : 'discard';
  } else if (raw.sport_scope === 'local') {
    // Local sport (sport_scope='local'): editorial if importance >= 3, else discard
    route = baseImportance >= 3 ? 'editorial' : 'discard';
  } else {
    // All other stories: editorial if importance >= 5, OR (importance >= 4 AND locality >= 6), OR (importance >= 3 AND locality >= 8)
    const qualifies =
      baseImportance >= 5 ||
      (baseImportance >= 4 && baseLocality >= 6) ||
      (baseImportance >= 3 && baseLocality >= 8);

    route = qualifies ? 'editorial' : 'discard';
  }

  const combined = Number(((baseImportance + baseLocality) / 2).toFixed(1));

  return {
    importance: baseImportance,
    locality: baseLocality,
    combined,
    route,
    sensitive,
  };
}
