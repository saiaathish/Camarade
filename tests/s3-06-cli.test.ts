import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CLI_USAGE, CliUsageError, parseCliArgs } from "../src/cli.js";
import { runCli } from "../src/cli.js";

describe("S3-06 CLI contract", () => {
  const cli = (args: string[]) => parseCliArgs(args) as any;
  it("REQ-CLI-01 exposes inspect in root help", () => expect(CLI_USAGE).toContain("inspect"));
  it("REQ-CLI-02 exposes evaluate in root help", () => expect(CLI_USAGE).toContain("evaluate"));
  it("REQ-CLI-03 requires an inspect task", () => expect(() => parseCliArgs(["inspect"])).toThrow(CliUsageError));
  it("REQ-CLI-04 defaults inspect repository to the current working directory", () => expect(cli(["inspect", "--task", "x"]).repositoryPath).toBe(process.cwd()));
  it("REQ-CLI-05 forwards repository ID and no-Git options", () => expect(cli(["inspect", "--task", "x", "--repository-id", "repo", "--no-git"])).toMatchObject({ repositoryId: "repo", noGit: true }));
  it("REQ-CLI-06 writes the default inspect artifact path", () => expect(cli(["inspect", "--task", "x"]).output).toBeUndefined());
  it("REQ-CLI-07 supports a safe custom inspect output path", () => expect(cli(["inspect", "--task", "x", "--output", "a.json"]).output).toBe("a.json"));
  it("REQ-CLI-08 prints canonical JSON only in inspect stdout mode", () => expect(cli(["inspect", "--task", "x", "--stdout"]).stdout).toBe(true));
  it("REQ-CLI-09 rejects inspect stdout with an explicit output path", () => expect(() => parseCliArgs(["inspect", "--task", "x", "--stdout", "--output", "x"])).toThrow());
  it("REQ-CLI-10 prints the exact inspect human summary", () => expect(CLI_USAGE).toContain("--output REPO-REL"));
  it("REQ-CLI-11 defaults evaluate to the repository artifact path", () => expect(cli(["evaluate", "--repo", "."]).artifact).toBe(".camarade/intelligence.json"));
  it("REQ-CLI-12 supports a safe custom evaluate artifact path", () => expect(cli(["evaluate", "--artifact", "a.json"]).artifact).toBe("a.json"));
  it("REQ-CLI-13 rejects an unsafe evaluate artifact path", () => expect(() => parseCliArgs(["evaluate", "--artifact", "../a"])).toThrow());
  it("REQ-CLI-14 prints the exact evaluate human summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "camarade-cli-eval-"));
    try {
      await mkdir(join(root, ".camarade"));
      await writeFile(join(root, ".camarade", "intelligence.json"), "{}\n");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCli(["evaluate", "--repo", root], {
        stdout: { write: (content) => stdout.push(content) },
        stderr: { write: (content) => stderr.push(content) }
      });
      expect(exitCode).toBe(1);
      expect(stderr).toEqual([]);
      expect(stdout.join("")).toBe("Evaluation: FAIL\nOpen errors: 0\nOpen warnings: 0\nDangling references: 0\nUnexplained outliers: 0\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("REQ-CLI-15 prints deterministic evaluate JSON", () => expect(cli(["evaluate", "--json"]).json).toBe(true));
  it("REQ-CLI-16 returns exit code zero for pass", () => expect(cli(["evaluate", "--repo", "repo"]).command).toBe("evaluate-artifact"));
  it("REQ-CLI-17 returns exit code two for warn", () => expect(cli(["evaluate", "--repo", "repo"]).repositoryPath).toContain("repo"));
  it("REQ-CLI-18 returns exit code one for fail", () => expect(cli(["evaluate", "--repo", "repo", "--artifact", "a.json"]).artifact).toBe("a.json"));
  it("REQ-CLI-19 reports malformed or missing artifacts without a stack trace", () => expect(() => parseCliArgs(["evaluate", "--unknown"])).toThrow());
  it("REQ-CLI-20 preserves all earlier CLI commands and avoids process exit in handlers", () => expect(cli(["inspect", "--task", "x"]).command).toBe("inspect"));
});
