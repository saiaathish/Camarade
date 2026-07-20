import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("benchmark certification infrastructure", () => {
  it("defines a checkpoint ledger with raw process streams", async () => {
    const source = await readFile(join(process.cwd(), "scripts/benchmark/checkpoint-ledger.ts"), "utf8");
    expect(source).toContain("stdout: string");
    expect(source).toContain("stderr: string");
    expect(source).toContain("recordCheckpoint");
  });
  it("keeps overnight certification scripts independent of package manifests", async () => {
    const source = await readFile(join(process.cwd(), "scripts/benchmark-overnight.ts"), "utf8");
    expect(source).toContain("certify:stage3");
    expect(source).not.toContain("package.json");
    expect(source).toContain("benchmark-report.json");
  });
});
