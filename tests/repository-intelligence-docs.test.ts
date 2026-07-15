import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const documentation = await readFile("docs/repository-intelligence.md", "utf8");

describe("repository intelligence documentation", () => {
  it("REQ-DOC-01 documents inspect evaluate artifact and exit-code usage", () => {
    expect(documentation).toContain("node dist/src/cli.js inspect");
    expect(documentation).toContain("node dist/src/cli.js evaluate");
    expect(documentation).toContain(".camarade/intelligence.json");
    expect(documentation).toContain("exit code `0`");
    expect(documentation).toContain("exit code `1`");
    expect(documentation).toContain("exit code `2`");
  });
  it("REQ-DOC-02 documents determinism safety and known limitations", () => {
    expect(documentation).toContain("byte-identical");
    expect(documentation).toContain("No automatic edits");
    expect(documentation).toContain("Stage 4");
    expect(documentation).toContain("MCP");
    expect(documentation).toContain("web UI");
    expect(documentation).toContain("bounded");
  });
  it("REQ-DOC-03 contains only commands supported by the implemented CLI", () => {
    expect(documentation).toContain("node dist/src/cli.js inspect --repo PATH --task TEXT");
    expect(documentation).toContain("node dist/src/cli.js evaluate --repo PATH [--artifact REPO-REL] [--json]");
    expect(documentation).not.toContain("node dist/src/cli.js analyze");
    expect(documentation).not.toContain("node dist/src/cli.js compile");
  });
});
