import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRunConfig } from "../src/config/load-run-config.js";
describe("Stage 5 configuration", () => { it("loads and canonicalizes experiment config", async () => { const root=await mkdtemp(join(tmpdir(),"cam-s5-")); try { await writeFile(join(root,"camarade.run.yaml"),"validationCommands: [npm test]\nexperiment:\n  instruction_mode: replacement\n  execution_order: camarade-first\n  codex:\n    executable: codex\n    timeout_seconds: 9\n    environment_allowlist: [Z_VAR, A_VAR]\n"); const c=await loadRunConfig(root); expect(c.experiment?.executionOrder).toBe("camarade-first"); expect(c.experiment?.codex.environmentAllowlist).toEqual(["A_VAR","Z_VAR"]); } finally { await rm(root,{recursive:true,force:true}); } }); });
