import {
  safeFetch as upstreamSafeFetch,
  assertPublicUrl,
  isSafeHttpUrl,
  SsrfError,
} from 'ssrf-safe-fetch';

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_REDIRECTS = 3;

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'metadata.google.internal',
  '169.254.169.254',
]);

/**
 * Validates that a URL is strictly HTTP or HTTPS and not a blocked or metadata host.
 */
export async function validateSafeUrl(rawUrl: string): Promise<URL> {
  if (!isSafeHttpUrl(rawUrl)) {
    throw new SsrfError(`Blocked invalid or non-HTTP(S) URL: ${rawUrl}`);
  }

  const parsed = new URL(rawUrl);
  const hostname = parsed.hostname.toLowerCase();

  if (
    BLOCKED_HOSTS.has(hostname) ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local')
  ) {
    throw new SsrfError(`Access to blocked or metadata host denied: ${hostname}`);
  }

  // Resolves DNS and blocks private, loopback, or link-local IPs
  await assertPublicUrl(rawUrl);

  return parsed;
}

export interface SafeFetchConfig {
  timeoutMs?: number;
  maxRedirects?: number;
}

/**
 * Executes an SSRF-safe HTTP request with strict validation, 30s default timeout,
 * 3-hop redirect limit with re-validation, and a 5 MB response body cap.
 */
export async function safeFetch(
  url: string,
  options: RequestInit = {},
  config: SafeFetchConfig = {}
): Promise<Response> {
  // Initial URL validation
  await validateSafeUrl(url);

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = config.maxRedirects ?? MAX_REDIRECTS;

  // Call upstream ssrf-safe-fetch with redirects and timeout
  const response = await upstreamSafeFetch(url, options, {
    maxRedirects,
    timeoutMs,
  });

  // Verify Content-Length header if present
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    throw new SsrfError(
      `Response body of ${contentLength} bytes exceeds the 5MB maximum limit`
    );
  }

  // Stream and buffer the response body, enforcing the 5MB hard cap
  if (!response.body) {
    return response;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value) {
        totalBytes += value.length;
        if (totalBytes > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new SsrfError(
            `Response stream exceeded the 5MB maximum limit (received ${totalBytes} bytes)`
          );
        }
        chunks.push(value);
      }
    }
  } catch (err: unknown) {
    if (err instanceof SsrfError) throw err;
    throw new SsrfError(
      `Failed to stream response body safely: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Concatenate chunks and wrap in a clean Response
  const combinedBuffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combinedBuffer.set(chunk, offset);
    offset += chunk.length;
  }

  return new Response(combinedBuffer, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export { SsrfError };
