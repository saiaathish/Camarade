# Hero demo: Next.js rate limiting

Fixture: TypeScript Next.js repository with existing auth and billing infrastructure, middleware, route handlers, tests, and Git history.

The root middleware instruction says apply a global rate limit to every request. A per-handler instruction says preserve the handler's existing unauthenticated response and rate-limit only the public API. The repository also contains a stale reference to `pages/api` although routes live under the App Router, plus an unnecessary rate-limit dependency recommendation when existing infrastructure already provides the primitive.

Task: implement rate limiting for the selected public endpoint while preserving protected authentication and billing files. Tests require excess requests to return HTTP 429. The compiled contract must resolve instruction precedence from live code/config evidence, reject the stale path and unnecessary dependency, identify protected files, and preserve existing validation commands.
