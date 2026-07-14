import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { loadRunConfig } from "../src/config/load-run-config.js";
import { RunConfigError } from "../src/core/errors.js";
import { isUnavailableEvidence } from "../src/core/types.js";

const roots: string[] = [];
async function repo(contents?: string): Promise<string> { const path = await mkdtemp(join(tmpdir(), "camarade-")); roots.push(path); if (contents !== undefined) await writeFile(join(path, "camarade.run.yaml"), contents); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const rejectsConfig = (path: string) => expect(loadRunConfig(path)).rejects.toBeInstanceOf(RunConfigError);

describe("loadRunConfig", () => {
  it("returns defaults when config is missing", async () => expect(await loadRunConfig(await repo())).toEqual({ configPath: null, validationCommands: [], timeoutSeconds: 1800 }));
  it("loads valid ordered, trimmed commands and ignores unknown fields", async () => { const path = await repo("validationCommands:\n  - ' npm test '\n  - npm run build\ntimeoutSeconds: 42\nfuture: ignored\n"); expect(await loadRunConfig(path)).toEqual({ configPath: join(path, "camarade.run.yaml"), validationCommands: ["npm test", "npm run build"], timeoutSeconds: 42 }); });
  it("uses defaults for omitted fields and empty YAML", async () => { expect((await loadRunConfig(await repo("future: yes\n"))).timeoutSeconds).toBe(1800); expect(await loadRunConfig(await repo(""))).toMatchObject({ validationCommands: [], timeoutSeconds: 1800 }); });
  it.each(["validationCommands: nope\n", "validationCommands:\n  - ' '\n", "validationCommands:\n  - npm test\n  - ' npm test '\n", "timeoutSeconds: 1.5\n", "timeoutSeconds: 0\n", "- item\n", "validationCommands: [npm test\n"]) ("rejects malformed config: %s", async (config) => rejectsConfig(await repo(config)));
  it("rejects missing and file repository paths", async () => { await rejectsConfig(join(tmpdir(), "camarade-does-not-exist")); const path = await repo(); const file = join(path, "file"); await writeFile(file, "x"); await rejectsConfig(file); });
  it("rejects a symlinked run configuration", async () => { const target = await repo("timeoutSeconds: 10\n"); const path = await repo(); await symlink(join(target, "camarade.run.yaml"), join(path, "camarade.run.yaml")); await rejectsConfig(path); });
});

describe("isUnavailableEvidence", () => {
  it("accepts valid evidence and rejects malformed evidence", () => { expect(isUnavailableEvidence({ unavailableReason: "not reported" })).toBe(true); expect(isUnavailableEvidence({ unavailableReason: "" })).toBe(false); expect(isUnavailableEvidence({ unavailableReason: "   " })).toBe(false); expect(isUnavailableEvidence(null)).toBe(false); expect(isUnavailableEvidence({ unavailableReason: 3 })).toBe(false); });
});
