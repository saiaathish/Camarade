import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileContext, type CompileContextInput } from "../src/compiler/compile-context.js";
import type { ContextSource } from "../src/core/types.js";

const repositories: string[] = [];

async function createRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "camarade-compiler-"));
  repositories.push(repositoryPath);
  await mkdir(join(repositoryPath, "src/compiler"), { recursive: true });
  await mkdir(join(repositoryPath, "tests"), { recursive: true });
  await writeFile(join(repositoryPath, "package.json"), "{}\n");
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n");
  await writeFile(join(repositoryPath, "src/compiler/existing.ts"), "export {};\n");
  await writeFile(join(repositoryPath, "tests/compiler.test.ts"), "export {};\n");
  return repositoryPath;
}

function source(repositoryPath: string, relativePath: string, kind: ContextSource["kind"], content: string, sha256: string): ContextSource {
  return { relativePath, absolutePath: join(repositoryPath, relativePath), kind, content, sha256 };
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repositoryPath) => rm(repositoryPath, { recursive: true, force: true })));
});

describe("compileContext", () => {
  it("produces a normalized canonical pack and ordered Markdown with source evidence", async () => {
    const repositoryPath = await createRepository();
    const sources = [
      source(repositoryPath, "AGENTS.md", "agents", [
        "# Rules",
        "- Keep the context compiler deterministic. ",
        "- Keep the context compiler deterministic.",
        "- Do not edit `package.json`.",
        "- Inspect `src/compiler/existing.ts` and `src/compiler/missing.ts` for compiler work."
      ].join("\r\n"), "agents-sha"),
      source(repositoryPath, "CLAUDE.md", "claude", [
        "# Instructions",
        "- Keep the context compiler deterministic.",
        "- Use `tests/compiler.test.ts` for context compiler validation."
      ].join("\n"), "claude-sha"),
      source(repositoryPath, "README.md", "readme", "# Welcome\nA cooking guide.\n", "readme-sha")
    ] satisfies ContextSource[];
    const input: CompileContextInput = {
      sources,
      task: "\r\n Implement a deterministic context compiler. \r\n",
      repositoryPath: ` ${repositoryPath} `,
      repositorySummary: "\r\n Small compiler fixture. \r\n",
      validationCommands: [" npm run typecheck\r\n", "npx vitest run tests/compiler.test.ts", "npm run typecheck"]
    };
    const before = JSON.stringify(input);

    const first = await compileContext(input);
    const second = await compileContext(input);

    expect(first).toEqual(second);
    expect(first.markdown).toBe(second.markdown);
    expect(JSON.stringify(input)).toBe(before);
    expect(first.contextPack).toEqual({
      task: "Implement a deterministic context compiler.",
      repositorySummary: "Small compiler fixture.",
      selectedSources: ["AGENTS.md", "CLAUDE.md"],
      instructions: [
        "[AGENTS.md] - Keep the context compiler deterministic.",
        "[AGENTS.md] - Do not edit `package.json`.",
        "[AGENTS.md] - Inspect `src/compiler/existing.ts` and `src/compiler/missing.ts` for compiler work.",
        "[CLAUDE.md] - Use `tests/compiler.test.ts` for context compiler validation."
      ],
      relevantFiles: ["src/compiler/existing.ts", "tests/compiler.test.ts"],
      protectedFiles: ["package.json"],
      validationCommands: ["npm run typecheck", "npx vitest run tests/compiler.test.ts"]
    });

    const headings = [
      "# Camarade Task Context",
      "## Task",
      "## Repository",
      "## Active Instructions",
      "## Relevant Files",
      "## Protected Files",
      "## Validation",
      "## Source Evidence"
    ];
    expect(headings.map((heading) => first.markdown.indexOf(heading))).toEqual(
      [...headings.map((heading) => first.markdown.indexOf(heading))].sort((left, right) => left - right)
    );
    expect(first.markdown).not.toContain("\r");
    expect(first.markdown).not.toContain(repositoryPath);
    expect(first.markdown).toContain("`AGENTS.md` — SHA-256 `agents-sha`");
    expect(first.markdown).toContain("`CLAUDE.md` — SHA-256 `claude-sha`");
    expect(first.markdown).not.toContain("readme-sha");
    expect(first.markdown).toContain("`src/compiler/missing.ts` — missing repository path referenced by `AGENTS.md`.");
    expect(first.markdown).toContain("`package.json` — protected by explicit instruction");
    expect(first.markdown).not.toMatch(/semantic(?:ally)? correct|conflict winner|benchmark gain/i);
  });

  it("extracts literal unquoted paths, applies explicit protection wording, and sorts generated file lists", async () => {
    const repositoryPath = await createRepository();
    await Promise.all([
      writeFile(join(repositoryPath, "src/compiler/a.ts"), "export {};\n"),
      writeFile(join(repositoryPath, "src/compiler/z.ts"), "export {};\n")
    ]);
    const input: CompileContextInput = {
      sources: [
        source(repositoryPath, "docs/compiler.md", "docs", [
          "# Compiler notes",
          "- Use src/compiler/z.ts and src/compiler/a.ts for compiler changes.",
          "- Use src/compiler/missing-only.ts for compiler work.",
          "- README.md is read-only."
        ].join("\n"), "docs-sha"),
        source(repositoryPath, "docs/unrelated.md", "docs", "# Gardening\nTomatoes need water.\n", "unrelated-sha")
      ],
      task: "Compile task context",
      repositoryPath,
      repositorySummary: "Fixture",
      validationCommands: []
    };

    const result = await compileContext(input);

    expect(result.contextPack.selectedSources).toEqual(["docs/compiler.md"]);
    expect(result.contextPack.relevantFiles).toEqual(["src/compiler/a.ts", "src/compiler/z.ts"]);
    expect(result.contextPack.protectedFiles).toEqual(["README.md"]);
    expect(result.markdown).toContain("`src/compiler/missing-only.ts` — missing repository path referenced by `docs/compiler.md`.");
    expect(result.contextPack.instructions.join("\n")).not.toContain("missing-only.ts");
    expect(result.markdown).not.toContain("unrelated-sha");
    expect(result.markdown).toContain("## Validation\n\n- None.");
  });

  it("omits stale-path and unsupported dependency-install instructions using repository evidence", async () => {
    const repositoryPath = await createRepository();
    const result = await compileContext({
      sources: [
        source(repositoryPath, "AGENTS.md", "agents", "- Do not add a rate-limit dependency; reuse `src/compiler/existing.ts`.\n", "agents-sha"),
        source(repositoryPath, "CLAUDE.md", "claude", "- Install and use `express-rate-limit`.\n", "claude-sha"),
        source(repositoryPath, ".cursor/rules/api.md", "cursor", "---\nglobs: pages/api/public/**/*.ts\n---\n- Public routes live under `pages/api/public/`.\n", "cursor-sha")
      ],
      task: "Add rate limiting to the public search API",
      repositoryPath,
      repositorySummary: "Hero-like fixture",
      validationCommands: ["npm test"]
    });

    expect(result.contextPack.instructions).toEqual([
      "[AGENTS.md] - Do not add a rate-limit dependency; reuse `src/compiler/existing.ts`."
    ]);
    expect(result.contextPack.relevantFiles).toEqual(["src/compiler/existing.ts"]);
    expect(result.markdown).toContain("`pages/api/public` — missing repository path");
    expect(result.markdown).toContain("omitted instruction");
    expect(result.markdown).not.toContain("globs: pages/api/public");
  });
});
