import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getScaffoldMessage } from "../src/cli.js";

const expectedMessage = "Camarade Stage 2 scaffold ready.";

describe("Stage 2 CLI scaffold", () => {
  it("returns the scaffold message without printing during import", () => {
    expect(getScaffoldMessage()).toBe(expectedMessage);
  });

  it("executes the real TypeScript CLI successfully", () => {
    const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");
    const cli = resolve("src/cli.ts");
    const stdout = execFileSync(process.execPath, [tsxCli, cli], {
      encoding: "utf8"
    });

    expect(stdout.trim()).toBe(expectedMessage);
  });
});
