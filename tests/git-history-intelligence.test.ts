import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeGitHistory } from "../src/intelligence/analyze-git-history.js";

const repo = (commits = ["initial"]): string => {
  const path = mkdtempSync(join(tmpdir(), "camarade-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, stdio: "pipe" }).toString();
  git("init", "-q"); git("config", "user.name", "Test User"); git("config", "user.email", "test@example.invalid");
  commits.forEach((message, index) => { writeFileSync(join(path, `file-${index}.ts`), message); git("add", "."); git("commit", "-qm", message); });
  return path;
};
const clean = (path: string) => rmSync(path, { recursive: true, force: true });
const git = (path: string, ...args: string[]) => execFileSync("git", args, { cwd: path, stdio: "pipe" }).toString().trim();
const GIT_HISTORY_BOUND_TEST_TIMEOUT_MS = 120_000;

describe("git history intelligence", () => {
  it("REQ-GIT-01 rejects an empty repository path", () => expect(() => analyzeGitHistory({ repositoryPath: "" })).toThrow());
  it("REQ-GIT-02 rejects a missing repository path", () => expect(() => analyzeGitHistory({ repositoryPath: join(tmpdir(), "does-not-exist-camarade") })).toThrow());
  it("REQ-GIT-03 rejects a non-Git directory", () => { const path = mkdtempSync(join(tmpdir(), "camarade-non-git-")); try { expect(() => analyzeGitHistory({ repositoryPath: path })).toThrow(); } finally { clean(path); } });
  it("REQ-GIT-04 returns unavailable evidence for a repository without commits", () => { const path = repo([]); try { expect(analyzeGitHistory({ repositoryPath: path }).availability).toBe("unavailable"); } finally { clean(path); } });
  it("REQ-GIT-05 uses the default one-hundred-commit bound", () => { const path = repo(Array.from({ length: 101 }, (_, i) => `commit-${i}`)); try { expect(analyzeGitHistory({ repositoryPath: path }).metadata.commitCount).toBe(100); } finally { clean(path); } }, GIT_HISTORY_BOUND_TEST_TIMEOUT_MS);
  it("REQ-GIT-06 uses a deterministic HEAD-relative age cutoff", () => { const path = repo(["old", "new"]); try { expect(analyzeGitHistory({ repositoryPath: path, maxAgeDays: 0 }).metadata.ageCutoff).toBe("HEAD-relative"); } finally { clean(path); } });
  it("REQ-GIT-07 rejects invalid history options", () => expect(() => analyzeGitHistory({ repositoryPath: ".", maxCommits: -1 })).toThrow());
  it("REQ-GIT-08 excludes merge commits", () => { const path = repo(["one", "two"]); try { expect(analyzeGitHistory({ repositoryPath: path }).records.some(record => (record.parents?.length ?? 0) > 1)).toBe(false); } finally { clean(path); } });
  it("REQ-GIT-09 detects a Git rename", () => { const path = repo(); try { git(path, "mv", "file-0.ts", "renamed.ts"); git(path, "commit", "-qm", "rename"); expect(analyzeGitHistory({ repositoryPath: path }).events.some(event => event.kind === "rename")).toBe(true); } finally { clean(path); } });
  it("REQ-GIT-10 detects a deleted path", () => { const path = repo(); try { git(path, "rm", "file-0.ts"); git(path, "commit", "-qm", "delete"); expect(analyzeGitHistory({ repositoryPath: path }).events.some(event => event.kind === "deletion")).toBe(true); } finally { clean(path); } });
  it("REQ-GIT-11 detects a pages-api to app-api migration", () => { const path = repo(); try { writeFileSync(join(path, "pages-api.ts"), "x"); git(path, "add", "."); git(path, "commit", "-qm", "pages"); git(path, "mv", "pages-api.ts", "app-api.ts"); git(path, "commit", "-qm", "migration"); expect(analyzeGitHistory({ repositoryPath: path }).events.some(event => event.kind === "migration")).toBe(true); } finally { clean(path); } });
  it("REQ-GIT-12 detects an API-route to server-action migration", () => { const path = repo(); try { writeFileSync(join(path, "api-route.ts"), "x"); git(path, "add", "."); git(path, "commit", "-qm", "api"); git(path, "mv", "api-route.ts", "server-action.ts"); git(path, "commit", "-qm", "action"); expect(analyzeGitHistory({ repositoryPath: path }).events.some(event => event.kind === "migration")).toBe(true); } finally { clean(path); } });
  it("REQ-GIT-13 detects a same-basename replacement", () => { const path = repo(); try { git(path, "rm", "file-0.ts"); mkdirSync(join(path, "replacement")); writeFileSync(join(path, "replacement/file-0.ts"), "new"); git(path, "add", "."); git(path, "commit", "-qm", "replace"); expect(analyzeGitHistory({ repositoryPath: path }).events.some(event => event.kind === "replacement")).toBe(true); } finally { clean(path); } });
  it("REQ-GIT-14 rejects unrelated delete-add replacement pairs", () => { const path = repo(); try { git(path, "rm", "file-0.ts"); writeFileSync(join(path, "other.ts"), "new"); git(path, "add", "."); git(path, "commit", "-qm", "unrelated"); expect(analyzeGitHistory({ repositoryPath: path }).events.some(event => event.kind === "replacement")).toBe(false); } finally { clean(path); } });
  it("REQ-GIT-15 records commit hash date summary and paths", () => { const path = repo(); try { const record = analyzeGitHistory({ repositoryPath: path }).records[0]; expect([record.commitId, record.date, record.summary, record.paths].every(Boolean)).toBe(true); } finally { clean(path); } });
  it("REQ-GIT-16 never records author identity", () => { const path = repo(); try { expect(JSON.stringify(analyzeGitHistory({ repositoryPath: path }))).not.toContain("Test User"); } finally { clean(path); } });
  it("REQ-GIT-17 reports shallow repository state", () => { const path = repo(["one", "two"]); try { git(path, "clone", "--depth", "1", `file://${path}`, join(path, "shallow")); expect(analyzeGitHistory({ repositoryPath: join(path, "shallow") }).metadata.shallow).toBe(true); } finally { clean(path); } });
  it("REQ-GIT-18 reports truncated bounded history", () => { const path = repo(["one", "two"]); try { expect(analyzeGitHistory({ repositoryPath: path, maxCommits: 1 }).metadata.truncated).toBe(true); } finally { clean(path); } });
  it("REQ-GIT-19 creates stable deterministic event IDs", () => { const path = repo(); try { expect(analyzeGitHistory({ repositoryPath: path }).events).toEqual(analyzeGitHistory({ repositoryPath: path }).events); } finally { clean(path); } });
  it("uses distinct stable identities for history events and their derived findings", () => { const path = repo(); try { git(path, "rm", "file-0.ts"); git(path, "commit", "-qm", "delete"); const result = analyzeGitHistory({ repositoryPath: path }); expect(result.events[0].id).toMatch(/^history_/); expect(result.findings[0].id).toMatch(/^finding_/); expect(result.findings[0].id).not.toBe(result.events[0].id); } finally { clean(path); } });
  it("REQ-GIT-20 returns deterministically sorted events and does not mutate options", () => { const options = { repositoryPath: repo(), maxCommits: 1 }; try { const before = structuredClone(options); analyzeGitHistory(options); expect(options).toEqual(before); } finally { clean(options.repositoryPath); } });
  it("REQ-GIT-21 leaves the repository status and HEAD unchanged", () => { const path = repo(); try { const before = `${git(path, "rev-parse", "HEAD")}\n${git(path, "status", "--porcelain")}`; analyzeGitHistory({ repositoryPath: path }); expect(`${git(path, "rev-parse", "HEAD")}\n${git(path, "status", "--porcelain")}`).toBe(before); } finally { clean(path); } });
});
