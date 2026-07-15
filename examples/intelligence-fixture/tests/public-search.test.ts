import assert from "node:assert/strict";
import test from "node:test";
import { publicSearch } from "../src/public-search.ts";
import { createRateLimitResponse } from "../src/rate-limit.ts";

test("fixture exposes the public search handler", () => {
  assert.equal(publicSearch(new Request("https://fixture.test/api/public/search?q=context")).status, 200);
});

test("rate-limit utility creates a meaningful HTTP 429 response", async () => {
  const response = createRateLimitResponse({ retryAfterSeconds: 60 });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.deepEqual(await response.json(), { error: "Too many requests" });
});
