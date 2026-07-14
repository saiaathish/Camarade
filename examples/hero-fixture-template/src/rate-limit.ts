export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  identify(request: Request): string;
  now?: () => number;
}

interface RateLimitWindow {
  count: number;
  resetsAt: number;
}

export type RateLimiter = (request: Request) => Response | null;

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const windows = new Map<string, RateLimitWindow>();
  const now = options.now ?? Date.now;

  return (request: Request): Response | null => {
    const timestamp = now();
    const key = options.identify(request);
    const current = windows.get(key);
    const window = current === undefined || timestamp >= current.resetsAt
      ? { count: 0, resetsAt: timestamp + options.windowMs }
      : current;

    window.count += 1;
    windows.set(key, window);

    if (window.count <= options.limit) return null;

    const retryAfterSeconds = Math.max(1, Math.ceil((window.resetsAt - timestamp) / 1_000));
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "retry-after": String(retryAfterSeconds) } }
    );
  };
}

