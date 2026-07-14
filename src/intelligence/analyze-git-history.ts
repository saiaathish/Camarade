import { execFileSync } from "node:child_process";
import { createStableId } from "./stable-id.js";
import type { IntelligenceFinding } from "./model.js";

export type GitHistoryEventKind = "rename" | "deletion" | "migration" | "replacement";
export interface GitHistoryRecord { commitId: string; status: string; path?: string; oldPath?: string; newPath?: string; similarity?: number; evidenceIds?: string[]; replacementPath?: string; replacedPath?: string; date?: string; summary?: string; paths?: string[]; parents?: string[]; }
export interface GitHistoryEvent { id: string; kind: GitHistoryEventKind; commitId: string; affectedPaths: string[]; evidenceIds: string[]; summary: string; explanation: string; }
export interface GitHistoryAnalysisInput { records?: readonly GitHistoryRecord[]; repositoryPath?: string; maxCommits?: number; maxRecords?: number; maxAgeDays?: number; }
export interface GitHistoryAnalysisResult { events: GitHistoryEvent[]; findings: IntelligenceFinding[]; records: GitHistoryRecord[]; availability: "available" | "unavailable"; metadata: { commitCount: number; ageCutoff: "HEAD-relative"; shallow: boolean; truncated: boolean; }; }

const pathOk = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value) && !value.split("/").includes("..") && !value.split("/").includes("") && !value.includes("\\");
const clean = (values: readonly string[] | undefined): string[] => [...new Set((values ?? []).filter((v): v is string => typeof v === "string" && v.length > 0))].sort();
const stem = (path: string): string => path.split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const parent = (path: string): string => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const validRecord = (r: GitHistoryRecord): boolean => typeof r?.commitId === "string" && r.commitId.length > 0 && typeof r.status === "string";
const run = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();

function readRepository(input: GitHistoryAnalysisInput, maxCommits: number, maxAgeDays?: number): { records: GitHistoryRecord[]; shallow: boolean; truncated: boolean } {
  if (input.repositoryPath === "") throw new Error("repositoryPath is required");
  if (!input.repositoryPath) return { records: [...(input.records ?? [])], shallow: false, truncated: false };
  try { run(input.repositoryPath, ["rev-parse", "--git-dir"]); } catch { throw new Error("repositoryPath must be a Git repository"); }
  let logOutput = ""; try { logOutput = run(input.repositoryPath, ["log", "--format=%H%x00%aI%x00%s%x00%P", "--no-merges", `--max-count=${maxCommits + 1}`]); } catch { return { records: [], shallow: false, truncated: false }; }
  const hashes = logOutput.trim().split("\n").filter(Boolean);
  const records: GitHistoryRecord[] = [];
  for (const line of hashes.slice(0, maxCommits)) {
    const [commitId, date, summary, parents] = line.split("\0");
    if (maxAgeDays !== undefined && Date.now() - Date.parse(date) > maxAgeDays * 86400000) continue;
    const diff = run(input.repositoryPath, ["diff-tree", "--root", "-r", "-M", "--no-commit-id", "--name-status", commitId]).trim();
    for (const item of diff.split("\n").filter(Boolean)) {
      const parts = item.split("\t"); const status = parts[0];
      const record: GitHistoryRecord = { commitId, date, summary, parents: parents ? parents.split(" ") : [], status, paths: parts.slice(1) };
      if (status.startsWith("R") && parts.length >= 3) { record.oldPath = parts[1]; record.newPath = parts[2]; record.similarity = Number(status.slice(1)) / 100; }
      else if (parts[1]) record.path = parts[1];
      records.push(record);
    }
  }
  let shallow = false; try { shallow = run(input.repositoryPath, ["rev-parse", "--is-shallow-repository"]).trim() === "true"; } catch { /* validated above */ }
  return { records, shallow, truncated: hashes.length > maxCommits };
}

export function analyzeGitHistory(input: GitHistoryAnalysisInput): GitHistoryAnalysisResult {
  if (!Number.isInteger(input.maxCommits) && input.maxCommits !== undefined || (input.maxCommits ?? 0) < 0 || !Number.isInteger(input.maxAgeDays) && input.maxAgeDays !== undefined || (input.maxAgeDays ?? 0) < 0) throw new Error("invalid history options");
  const maxCommits = input.maxCommits ?? 100; const maxRecords = input.maxRecords ?? 1000;
  if (!Number.isInteger(maxRecords) || maxRecords < 0) throw new Error("invalid history options");
  const loaded = readRepository(input, maxCommits, input.maxAgeDays); const records = loaded.records.filter(validRecord).slice(0, maxRecords);
  const available = records.length > 0 || !input.repositoryPath;
  const commits = [...new Set(records.map(r => r.commitId))].sort().slice(0, maxCommits); const allowed = new Set(commits);
  const accepted = records.filter(r => allowed.has(r.commitId)).map(r => ({ ...r, oldPath: pathOk(r.oldPath) ? r.oldPath : undefined, newPath: pathOk(r.newPath) ? r.newPath : undefined, path: pathOk(r.path) ? r.path : undefined, replacementPath: pathOk(r.replacementPath) ? r.replacementPath : undefined, replacedPath: pathOk(r.replacedPath) ? r.replacedPath : undefined })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const events: GitHistoryEvent[] = []; const add = (kind: GitHistoryEventKind, r: GitHistoryRecord, paths: string[], text: string): void => { const affectedPaths = clean(paths); const evidenceIds = clean(r.evidenceIds); events.push({ id: createStableId("finding", ["git-history", kind, r.commitId, affectedPaths, evidenceIds]), kind, commitId: r.commitId, affectedPaths, evidenceIds, summary: text, explanation: `${text} Evidence is limited to supplied commit ${r.commitId} and paths.` }); };
  for (const r of accepted) { const status = r.status.toUpperCase(); if (r.oldPath && r.newPath && (status.startsWith("R") || (typeof r.similarity === "number" && r.similarity >= 0.8))) { const kind = /pages|api|route|action/.test(`${r.oldPath}/${r.newPath}`) ? "migration" : "rename"; add(kind, r, [r.oldPath, r.newPath], `${kind === "rename" ? "Renamed" : "Migrated"} ${r.oldPath} to ${r.newPath}.`); } else if (status === "D" && r.path) add("deletion", r, [r.path], `Deleted ${r.path}.`); else if (status === "A" && r.path) { const deletion = accepted.find(d => d.commitId === r.commitId && d.status === "D" && d.path && stem(d.path) === stem(r.path!) && d.path.split("/").pop() === r.path!.split("/").pop()); if (deletion) add("replacement", r, [deletion.path!, r.path], `Replaced ${deletion.path} with ${r.path}.`); } }
  const unique = [...new Map(events.map(e => [e.id, e])).values()].sort((a, b) => a.id.localeCompare(b.id));
  return { events: unique, findings: unique.map(e => ({ id: e.id, kind: "exception", summary: e.summary, evidenceIds: e.evidenceIds, affectedRuleIds: [], severity: "info", status: "open", explanation: e.explanation })), records, availability: available ? "available" : "unavailable", metadata: { commitCount: new Set(records.map(r => r.commitId)).size, ageCutoff: "HEAD-relative", shallow: loaded.shallow, truncated: loaded.truncated } };
}
