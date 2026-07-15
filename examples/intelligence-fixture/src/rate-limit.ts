export interface RateLimitResponseOptions {
  retryAfterSeconds: number;
  message?: string;
}

export function createRateLimitResponse(options: RateLimitResponseOptions): Response {
  if (!Number.isFinite(options.retryAfterSeconds) || options.retryAfterSeconds <= 0) {
    throw new RangeError("retryAfterSeconds must be a positive number");
  }

  return Response.json(
    { error: options.message ?? "Too many requests" },
    {
      status: 429,
      headers: { "retry-after": String(Math.ceil(options.retryAfterSeconds)) }
    }
  );
}
