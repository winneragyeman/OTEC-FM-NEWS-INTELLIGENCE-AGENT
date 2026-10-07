import fs from 'fs';
import path from 'path';

let cachedGazetteer: string[] | null = null;

const SHORT_RISK_NAMES = new Set(['Wa', 'Ho', 'Ada', 'Tema']);

const DIRECTIONAL_REGION_NAMES = new Set([
  'Northern',
  'Central',
  'Eastern',
  'Western',
  'Upper East',
  'Upper West',
]);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reads config/ghana-locations.json on first call, caches in memory for the process lifetime.
 * Returns locations sorted by length descending so longer compound names are checked before shorter names.
 */
export function loadGazetteer(): string[] {
  if (cachedGazetteer) {
    return cachedGazetteer;
  }

  const filePath = path.resolve(process.cwd(), 'config/ghana-locations.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Gazetteer configuration file not found at ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error('Gazetteer configuration must be an array of strings');
  }

  // Deduplicate and sort by string length descending to ensure longer names match first.
  // Directional region names are included so findLocations can process them under the directional branch.
  const allLocations = [...parsed.map((s: string) => s.trim()), ...DIRECTIONAL_REGION_NAMES];
  const unique = Array.from(new Set(allLocations)).filter(Boolean);
  unique.sort((a, b) => b.length - a.length);

  cachedGazetteer = unique;
  return cachedGazetteer;
}

/**
 * Returns string[] of Ghanaian locations found in the text according to strict rules:
 * - Rejects matches inside URLs (http:// or https:// followed by non-whitespace).
 * - Checks long locations first ("Sekondi-Takoradi" before "Takoradi") and masks matched
 *   spans to prevent partial matches.
 * - Directional region names ("Northern", "Central", etc.) require "Region" immediately following.
 * - Word-boundary matching (case-insensitive) for standard names.
 * - Short names with high false-positive risk ("Wa", "Ho", "Ada", "Tema") require:
 *   appearing capitalised at a sentence boundary OR after a geographic preposition ("in", "at", "near", "from", "to").
 * - Returns unique locations in original capitalisation from the gazetteer.
 */
export function findLocations(text: string): string[] {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const gazetteer = loadGazetteer();

  // Strip URLs by replacing them with whitespace of equivalent length so character offsets are preserved
  let workingText = text.replace(/https?:\/\/[^\s]+/gi, (urlMatch) => ' '.repeat(urlMatch.length));

  const foundLocations = new Set<string>();

  for (const location of gazetteer) {
    if (foundLocations.has(location)) {
      continue;
    }

    if (DIRECTIONAL_REGION_NAMES.has(location)) {
      // Skip directional matching entirely if the text has no Ghana context
      const hasGhana = /\bGhana\b/i.test(workingText);
      if (!hasGhana) {
        continue;
      }
      const directionalPattern = new RegExp(`\\b${escapeRegex(location)}\\s+Region\\b`, 'i');
      if (directionalPattern.test(workingText)) {
        foundLocations.add(location);
        workingText = workingText.replace(directionalPattern, (m) => ' '.repeat(m.length));
      }
      continue;
    }

    if (SHORT_RISK_NAMES.has(location)) {
      // Require word to appear capitalised at a sentence boundary OR after a geographic preposition
      // Sentence boundary: start of text or following . ! ? with optional whitespace
      // Geographic preposition: in, at, near, from, to
      const prep = '(?:[Ii]n|[Aa]t|[Nn]ear|[Ff]rom|[Tt]o)';
      const shortPattern = new RegExp(
        `(?:(?:^|[.!?]\\s+)|\\b${prep}\\s+)\\b${escapeRegex(location)}\\b`,
        'm'
      );

      const match = shortPattern.exec(workingText);
      if (match) {
        foundLocations.add(location);
        // Mask out the matched location name within the text to prevent re-matching
        const locIndex = match.index + match[0].lastIndexOf(location);
        workingText =
          workingText.slice(0, locIndex) +
          ' '.repeat(location.length) +
          workingText.slice(locIndex + location.length);
      }
    } else {
      // Word-boundary matching (case-insensitive)
      const standardPattern = new RegExp(`\\b${escapeRegex(location)}\\b`, 'i');
      if (standardPattern.test(workingText)) {
        foundLocations.add(location);
        // Mask out occurrences of the matched location so shorter substring names do not match
        workingText = workingText.replace(
          new RegExp(`\\b${escapeRegex(location)}\\b`, 'gi'),
          (m) => ' '.repeat(m.length)
        );
      }
    }
  }

  return Array.from(foundLocations);
}
