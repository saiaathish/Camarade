import assert from "node:assert/strict";
import test from "node:test";
import { publicSearch } from "../src/public-search.ts";

test("public search returns HTTP 429 after the request limit", async () => {
  const request = () => new Request("https://fixture.test/api/public/search?q=context", {
    headers: { "x-forwarded-for": "203.0.113.10" }
  });

  assert.equal((await publicSearch(request())).status, 200);
  assert.equal((await publicSearch(request())).status, 200);

  const limited = await publicSearch(request());
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.deepEqual(await limited.json(), { error: "Too many requests" });
});

