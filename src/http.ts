/**
 * The one HTTP path every provider goes through.
 *
 * Everything providers need from the network lives here so that retry policy,
 * timeouts, and — most importantly — secret redaction are decided once. Nothing
 * else in the package is allowed to call `fetch` directly; `fetchImpl` is
 * injected so the test suite runs entirely against recorded fixtures.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type QueryValue = string | number | boolean | ReadonlyArray<string | number> | undefined;

/**
 * How to serialise array query params. Platforms disagree:
 * `repeat` → `group_by=model&group_by=project_id` (OpenAI)
 * `bracket` → `group_by[]=model&group_by[]=api_key_id` (Anthropic)
 */
export type ArrayFormat = 'repeat' | 'bracket';

export type RequestOptions = {
  headers?: Record<string, string>;
  query?: Record<string, QueryValue>;
  arrayFormat?: ArrayFormat;
  body?: unknown;
  method?: 'GET' | 'POST';
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodyText: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} from ${url}: ${bodyText}`);
    this.name = 'HttpError';
  }

  /** 401/403 mean "wrong kind of credential", which callers report differently. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export type HttpClientConfig = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Literal secret values to scrub from every error message and log line. */
  secrets?: readonly string[];
  userAgent?: string;
};

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;

/** Key shapes that must never reach a terminal, even if a caller forgets. */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /sk-or-v1-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]{8,}/g,
];

export function redact(text: string, secrets: readonly string[] = []): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length >= 8) output = output.split(secret).join('[redacted]');
  }
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, '[redacted]');
  }
  return output;
}

export function buildQuery(
  query: Record<string, QueryValue>,
  arrayFormat: ArrayFormat = 'repeat',
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const name = arrayFormat === 'bracket' ? `${key}[]` : key;
      for (const item of value) params.append(name, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly secrets: readonly string[];
  private readonly userAgent: string;

  constructor(config: HttpClientConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.secrets = config.secrets ?? [];
    this.userAgent = config.userAgent ?? 'aiusage';
  }

  async json<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const target = url + buildQuery(options.query ?? {}, options.arrayFormat);
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.userAgent,
      ...options.headers,
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const init: RequestInit = { method, headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    const response = await this.send(target, init);
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(
        response.status,
        this.safe(target),
        this.safe(text.slice(0, 500)),
        `Malformed JSON from ${this.safe(target)}`,
      );
    }
  }

  private async send(target: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) await this.sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      try {
        const response = await this.fetchImpl(target, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok) return response;

        const bodyText = await response.text().catch(() => '');
        const error = new HttpError(response.status, this.safe(target), this.safe(bodyText));
        if (!RETRYABLE_STATUSES.has(response.status) || attempt === this.maxRetries) throw error;

        lastError = error;
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        // Honour the server's own pacing instead of our backoff when given.
        if (retryAfter !== null) await this.sleep(retryAfter);
      } catch (error) {
        if (error instanceof HttpError && !RETRYABLE_STATUSES.has(error.status)) throw error;
        if (attempt === this.maxRetries) throw this.wrap(error, target);
        lastError = error;
      }
    }
    throw this.wrap(lastError, target);
  }

  private wrap(error: unknown, target: string): Error {
    if (error instanceof HttpError) return error;
    const reason = error instanceof Error ? error.message : String(error);
    return new Error(`Request to ${this.safe(target)} failed: ${this.safe(reason)}`);
  }

  private safe(text: string): string {
    return redact(text, this.secrets);
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}
