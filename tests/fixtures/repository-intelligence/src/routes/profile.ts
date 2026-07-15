import { middleware } from "../shared/middleware.js";

export function GET(request: Request): Response {
  return middleware(request, () => Response.json({ ok: true }));
}
