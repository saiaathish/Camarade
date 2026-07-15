import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ContextSource, ContextSourceKind } from "../core/types.js";
import { analyzeGitHistory, type GitHistoryAnalysisInput, type GitHistoryRecord, type GitHistoryAnalysisResult } from "./analyze-git-history.js";
import { buildEvidenceGraph } from "./build-evidence-graph.js";
import { buildIntelligenceArtifact, serializeIntelligenceArtifact, type IntelligenceArtifact } from "./build-intelligence-artifact.js";
import { detectRuleContradictions } from "./detect-contradictions.js";
import { detectDuplicateRules } from "./detect-duplicates.js";
import { detectExceptions } from "./detect-exceptions.js";
import { generateIntelligenceRecommendations } from "./generate-recommendations.js";
import { inventoryRepository } from "./inventory-repository.js";
import { mineRepositoryConventions } from "./mine-conventions.js";
import { parseInstructionSegments } from "./parse-instructions.js";
import { resolveRuleReferences } from "./resolve-references.js";
import { scoreFindingConfidence } from "./score-confidence.js";
import { segmentContextSources } from "./segment-sources.js";
import { createStableId } from "./stable-id.js";

export interface CompileRepositoryIntelligenceOptions { repositoryPath: string; task: string; repositoryId?: string; includeGitHistory?: boolean; gitHistoryOptions?: Omit<GitHistoryAnalysisInput, "repositoryPath" | "records">; }
export interface CompiledRepositoryIntelligence { artifact: IntelligenceArtifact & { history: GitHistoryAnalysisResult & { unavailableReason?: string } }; artifactJson: string; inventory: Awaited<ReturnType<typeof inventoryRepository>>; sources: ContextSource[]; }
export type CompileRepositoryIntelligenceInput = CompileRepositoryIntelligenceOptions & { historyRecords?: readonly GitHistoryRecord[]; outliers?: Parameters<typeof detectExceptions>[0]["outliers"] };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sourceKind = (p: string): ContextSourceKind => p === "AGENTS.md" ? "agents" : p === "CLAUDE.md" ? "claude" : p.startsWith(".cursor/rules/") ? "cursor" : p === ".github/copilot-instructions.md" ? "copilot" : p === "README.md" ? "readme" : p.startsWith("docs/") ? "docs" : "configuration";
export async function compileRepositoryIntelligence(input: CompileRepositoryIntelligenceInput): Promise<CompiledRepositoryIntelligence> {
  if (!input.repositoryPath.trim()) throw new Error("repositoryPath must be non-empty.");
  if (!input.task.trim()) throw new Error("task must be non-empty.");
  const inventory = await inventoryRepository(input.repositoryPath);
  const packageFile = inventory.files.find(f => f.relativePath === "package.json");
  let packageName = "";
  if (packageFile) { try { packageName = String(JSON.parse(await readFile(path.join(input.repositoryPath, "package.json"), "utf8")).name ?? "").trim(); } catch { /* inventory remains authoritative */ } }
  const repositoryId = input.repositoryId !== undefined ? input.repositoryId.trim() : packageName || path.basename(path.resolve(input.repositoryPath));
  if (!repositoryId) throw new Error("repositoryId must be non-empty.");
  const sourceFiles = inventory.files.filter(f => f.kind === "instruction" || f.kind === "documentation" || f.relativePath === "package.json");
  const sources: ContextSource[] = await Promise.all(sourceFiles.map(async f => { const content = await readFile(path.join(input.repositoryPath, f.relativePath), "utf8"); return { relativePath: f.relativePath, absolutePath: path.join(input.repositoryPath, f.relativePath), kind: sourceKind(f.relativePath), content, sha256: sha(content) }; }));
  const sourceRecords = sources.map(s => ({ id: createStableId("source", [s.relativePath, s.sha256]), sourceType: s.kind === "configuration" ? "configuration" as const : s.kind === "docs" || s.kind === "readme" ? "documentation" as const : "instruction" as const, relativePath: s.relativePath, sha256: s.sha256, authority: s.kind === "agents" ? "high" as const : "medium" as const }));
  const segmented = segmentContextSources(sources); const parsed = parseInstructionSegments(sourceRecords, segmented.segments); const refs = resolveRuleReferences(parsed.rules, inventory);
  const duplicate = detectDuplicateRules(parsed.rules); const contradiction = detectRuleContradictions(parsed.rules); const conventions = mineRepositoryConventions({ inventory, rules: parsed.rules, evidence: sourceRecords });
  let history: ReturnType<typeof analyzeGitHistory>;
  if (input.includeGitHistory === false) history = { ...analyzeGitHistory({ records: [] }), availability: "unavailable", unavailableReason: "Git-history analysis disabled." } as typeof history & { unavailableReason: string };
  else { try { history = analyzeGitHistory(input.historyRecords ? { records: input.historyRecords, ...input.gitHistoryOptions } : { repositoryPath: input.repositoryPath, ...input.gitHistoryOptions }); } catch (error) { if (error instanceof Error && error.message === "repositoryPath must be a Git repository") history = { ...analyzeGitHistory({ records: [] }), availability: "unavailable", unavailableReason: "Git-history analysis unavailable: repository is not a Git repository." } as typeof history & { unavailableReason: string }; else throw error; } }
  const exceptions = detectExceptions({ rules: parsed.rules, inventory, conventions: conventions.conventions, history: history.events.map(e => ({ relativePath: e.affectedPaths[0], description: e.summary })), outliers: input.outliers });
  const findings = [...refs.findings, ...duplicate.findings, ...contradiction.findings, ...conventions.findings, ...history.findings, ...exceptions.findings].sort((a, b) => a.id.localeCompare(b.id));
  const confidenceAssessments = scoreFindingConfidence({ findings, rules: parsed.rules, evidence: parsed.evidence, sources: sourceRecords, references: refs.references, architectureDecisions: conventions.architectureDecisions, history, exceptions: exceptions.exceptions });
  const recommendations = generateIntelligenceRecommendations({ findings, confidenceAssessments });
  const graph = buildEvidenceGraph({ inventory, sources: sourceRecords, evidence: parsed.evidence, rules: parsed.rules, references: refs.references, findings, conventions: conventions.conventions, architectureDecisions: conventions.architectureDecisions, history, exceptions: exceptions.exceptions, confidenceAssessments, recommendations });
  const artifact = buildIntelligenceArtifact({ repositoryId, task: input.task, inventory, sources: sourceRecords, evidence: parsed.evidence, rules: parsed.rules, references: refs.references, findings, conventions: conventions.conventions, architectureDecisions: conventions.architectureDecisions, history, exceptions: exceptions.exceptions, unexplainedOutlierPaths: exceptions.unexplainedOutliers.map(o => o.relativePath ?? o.fileId ?? o.id ?? ""), confidenceAssessments, recommendations, graph: graph as never });
  return { artifact, artifactJson: serializeIntelligenceArtifact(artifact), inventory, sources };
}
