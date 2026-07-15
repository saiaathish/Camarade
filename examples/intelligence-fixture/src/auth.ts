export function requireUser(request: Request): Response | null {
  return request.headers.get("authorization") === "Bearer fixture-user"
    ? null
    : Response.json({ error: "Unauthorized" }, { status: 401 });
}
