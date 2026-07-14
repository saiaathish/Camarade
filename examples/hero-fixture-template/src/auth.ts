export function requireUser(request: Request): Response | null {
  if (request.headers.get("authorization") === "Bearer fixture-user") return null;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

