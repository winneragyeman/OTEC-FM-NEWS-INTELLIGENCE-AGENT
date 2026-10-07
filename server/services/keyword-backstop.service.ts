/**
 * Keyword Backstop Service
 *
 * Fast, deterministic pre-check for high-risk sensitive topics in Ghanaian news.
 * Any match forces sensitive_content = true and prevents the LLM from lowering sensitivity.
 */

export const KEYWORD_CATEGORIES: Record<string, RegExp> = {
  fatalities: /\b(killed|dead|death|fatal|corpse|died|murder|suicide|manslaughter)\b/i,
  chieftaincy: /\b(Asantehene|Otumfuo|destool|enstool|traditional council|chief|queenmother|omanhene)\b/i,
  legal: /\b(contempt of court|sub judice|arrested|charged|court order|prosecution)\b/i,
  accusation: /\b(alleged|accused|suspected|embezzled|diverted|misappropriated)\b/i,
  minors: /\b(underage|minor child|minors|girl|boy)\b/i,
};

export interface KeywordCheckResult {
  matched: boolean;
  flags: string[];
}

/**
 * Checks text against word-boundary regex patterns for sensitive Ghanaian news categories.
 * Returns { matched: boolean, flags: string[] } where flags is a list of matched categories.
 */
export function checkKeywords(text: string): KeywordCheckResult {
  if (!text || typeof text !== 'string') {
    return { matched: false, flags: [] };
  }

  const flags: string[] = [];

  for (const [category, regex] of Object.entries(KEYWORD_CATEGORIES)) {
    if (regex.test(text)) {
      flags.push(category);
    }
  }

  return {
    matched: flags.length > 0,
    flags,
  };
}
