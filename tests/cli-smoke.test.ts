import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_USAGE } from "../src/cli.js";

describe("Stage 2 CLI import and process smoke behavior", () => {
  it("exports real evaluate usage without printing during import", () => {
    expect(CLI_USAGE).toContain("camarade evaluate");
    expect(CLI_USAGE).not.toContain("scaffold");
  });

  it("lists every routed command in the usage text", () => {
    expect(CLI_USAGE).toMatch(/^Usage: camarade/);
    for (const command of ["measure", "explain", "compile", "inspect", "evaluate", "runs", "show"]) {
      expect(CLI_USAGE).toContain(`camarade ${command}`);
    }
  });

  it("rejects missing CLI input without a stack trace", () => {
    const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");
    const cli = resolve("src/cli.ts");
    const result = spawnSync(process.execPath, [tsxCli, cli], {
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Problem: Missing command: evaluate.");
    expect(result.stderr).not.toContain("    at ");
  });
});
