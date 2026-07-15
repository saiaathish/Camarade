import assert from "node:assert/strict";
import test from "node:test";
import { publicSearch } from "../src/public-search.ts";

test("fixture exposes the public search handler", () => {
  assert.equal(publicSearch(new Request("https://fixture.test/api/public/search?q=context")).status, 200);
});
