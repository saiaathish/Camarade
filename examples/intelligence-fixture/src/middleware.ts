export function middleware(request: Request, next: () => Response): Response {
  if (new URL(request.url).pathname !== "/api/public/search") return next();
  return next();
}
