export function middleware(request: Request, next: () => Response): Response {
  if (!request.headers.get("authorization")) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return next();
}
