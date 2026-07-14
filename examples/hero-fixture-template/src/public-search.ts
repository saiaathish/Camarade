import { middleware } from "./middleware.ts";

export function publicSearch(request: Request): Promise<Response> {
  return middleware(request, () => {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return Response.json({ query, results: ["camarade"] });
  });
}

