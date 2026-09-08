interface FetchOptions extends RequestInit {
  timeout?: number;
  retries?: number;
  dedupe?: boolean;
  onRetry?: (attempt: number, error: Error) => void;
}

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_RETRIES = 2;
const DEFAULT_DEDUPE = true;

const inFlight = new Map<string, Promise<Response>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status >= 500;
}

export function createRequestKey(url: string, options?: FetchOptions): string {
  const { method = "GET", body, headers } = options ?? {};
  const headerStr = headers ? new Headers(headers).toString() : "";
  return [method.toUpperCase(), url, headerStr, body ? String(body) : ""].join(
    "\u0001",
  );
}

export async function fetchWithTimeout(
  url: string,
  options: FetchOptions = {},
): Promise<Response> {
  const {
    timeout = DEFAULT_TIMEOUT,
    retries = DEFAULT_RETRIES,
    dedupe = DEFAULT_DEDUPE,
    onRetry,
    ...init
  } = options;

  const key = createRequestKey(url, options);

  if (dedupe) {
    const existing = inFlight.get(key);
    if (existing) return existing;
  }

  const attempt = async (): Promise<Response> => {
    let lastError: Error | null = null;
    let lastStatus: number | undefined;

    for (let i = 0; i <= retries; i++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);

      try {
        const res = await fetch(url, { ...init, signal: ctl.signal });
        lastStatus = res.status;
        if (res.ok || !shouldRetry(res.status)) {
          return res;
        }
        lastError = new Error(`Request failed with status ${res.status}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      } finally {
        clearTimeout(timer);
      }

      if (i < retries) {
        await sleep(250 * 2 ** i);
        onRetry?.(i + 1, lastError ?? new Error("unknown error"));
      }
    }

    throw lastError ?? new Error(`Request failed with status ${lastStatus}`);
  };

  const promise = attempt();

  if (dedupe) {
    inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(key);
    }
  }

  return promise;
}

export async function fetchJSON<T>(
  url: string,
  options?: FetchOptions,
): Promise<T> {
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}
