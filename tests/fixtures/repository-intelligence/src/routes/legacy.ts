export function legacy(request: Request): Response {
  if (!request.headers.get("authorization")) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ ok: true });
}
