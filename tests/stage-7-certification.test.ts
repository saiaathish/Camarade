import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run=promisify(execFile);
describe("S7-04 deterministic certification",()=>{it("emits only success after real certification and exact safety fields",async()=>{const {stdout}=await run("npx",["tsx","scripts/certify-stage-7.ts"],{cwd:process.cwd()});const value=JSON.parse(stdout.trim());expect(value.status).toBe("pass");expect(value.simulation).toBe(true);expect(value.realModelExecuted).toBe(false);expect(value.networkUsed).toBe(false);expect(value.disclaimer).toBe("This result proves deterministic pipeline behavior only. It is not real benchmark evidence or an agent-quality claim.");expect(value.cleanup).toBe("pass");},30000);});
