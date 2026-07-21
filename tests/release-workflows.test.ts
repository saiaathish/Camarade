import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "../scripts/lib/portable-command.js";

const workflow = (name: string) => readFile(join(process.cwd(), ".github", "workflows", name), "utf8");

describe("release workflows", () => {
  it("certifies Ubuntu Node 20/22, macOS Node 22, and Windows Node 22 from clean installs", async () => {
    const ci = await workflow("ci.yml");
    expect(ci).toContain("npm ci");
    expect(ci).toContain("npm --prefix frontend ci");
    expect(ci).toContain("npm run certify:ci");
    expect(ci).toMatch(/ubuntu-latest[\s\S]*node: 20[\s\S]*ubuntu-latest[\s\S]*node: 22[\s\S]*macos-latest[\s\S]*node: 22[\s\S]*windows-latest[\s\S]*node: 22/u);
    expect(ci).toContain("coverage/**");
  });

  it("resolves top-level release scripts to this repository root", () => {
    const scriptUrl = pathToFileURL(join(process.cwd(), "scripts", "certify-ci.ts")).href;
    expect(repositoryRoot(scriptUrl)).toBe(process.cwd());
  });
});
