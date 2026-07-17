import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimiter } from "../src/rate-limit.ts";

test("rate-limit window resets deterministically", () => {
  let now = 1_000;
  const limiter = createRateLimiter({
    limit: 1,
    windowMs: 1_000,
    identify: () => "hero-client",
    now: () => now
  });
  const request = new Request("https://fixture.test/api/public/search");

  assert.equal(limiter(request), null);
  assert.equal(limiter(request)?.status, 429);
  now = 2_000;
  assert.equal(limiter(request), null);
});
