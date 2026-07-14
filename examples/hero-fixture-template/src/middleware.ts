import { createRateLimiter } from "./rate-limit.ts";

const publicSearchLimiter = createRateLimiter({
  limit: 2,
  windowMs: 60_000,
  identify: (request) => request.headers.get("x-forwarded-for") ?? "anonymous"
});

export async function middleware(
  request: Request,
  next: () => Response | Promise<Response>
): Promise<Response> {
  if (new URL(request.url).pathname !== "/api/public/search") return next();

  const limited = publicSearchLimiter(request);
  return limited ?? next();
}

export const config = { matcher: "/api/:path*" };

