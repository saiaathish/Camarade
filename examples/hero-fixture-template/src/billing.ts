import { requireUser } from "./auth.ts";

export function billingPortal(request: Request): Response {
  const unauthorized = requireUser(request);
  if (unauthorized !== null) return unauthorized;
  return Response.json({ portal: "/billing/fixture-user" });
}

