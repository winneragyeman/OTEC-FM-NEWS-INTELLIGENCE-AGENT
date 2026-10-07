/**
 * Sanitizes untrusted text input before supplying it to LLM prompts.
 */
export function sanitizeUntrustedInput(text: string): string {
  if (!text) return '';

  // Step 1: Unicode NFKC normalize
  let sanitized = text.normalize('NFKC');

  // Step 2: Strip zero-width characters (\u200B-\u200D, \uFEFF)
  sanitized = sanitized.replace(/[\u200B-\u200D\uFEFF]/g, '');

  // Step 3: Strip bidi-control characters (\u202A-\u202E)
  sanitized = sanitized.replace(/[\u202A-\u202E]/g, '');

  // Step 4: Remove known prompt injection patterns
  const injectionPatterns = [
    /ignore\s+previous\s+instructions/gi,
    /\bsystem\s*:/gi,
    /\bassistant\s*:/gi,
  ];

  for (const pattern of injectionPatterns) {
    sanitized = sanitized.replace(pattern, '');
  }

  // Step 5: Truncate to 8000 characters
  if (sanitized.length > 8000) {
    sanitized = sanitized.slice(0, 8000);
  }

  return sanitized;
}
