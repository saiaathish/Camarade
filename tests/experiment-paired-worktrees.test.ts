import { describe, expect, it } from "vitest";
import { isPathWithin } from "../src/experiment/git.js";
describe("paired worktree invariants",()=>{it("rejects nested condition paths",()=>expect(isPathWithin("/tmp/a","/tmp/a/b")).toBe(true));});
