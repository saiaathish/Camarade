import { middleware } from "./middleware.ts";

export function publicSearch(request: Request): Response {
  return middleware(request, () => Response.json({ query: new URL(request.url).searchParams.get("q") }));
}
