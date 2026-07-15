import type { ContextContractItem, TaskContextContract, UnresolvedContextItem } from "./context-types.js";
import { characterCount, compareText, uniqueSorted } from "./context-serialization.js";

const escapeMarkdown = (value: string): string => value
  .replace(/\\/g, "\\\\")
  .replace(/([`*_{}\[\]<>#+.!|])/g, "\\$1")
  .replace(/-/g, "\\-")
  .replace(/\r\n?|\n/g, "<br>");

const code = (value: string): string => {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
};

const list = (values: readonly string[]): string => uniqueSorted(values).map(code).join(", ");
const bulletList = (values: readonly string[]): string => values.length === 0
  ? "_None._"
  : [...values].sort(compareText).map((value) => `- ${escapeMarkdown(value)}`).join("\n");

function renderItems(items: readonly ContextContractItem[]): string {
  if (items.length === 0) return "_None._";
  return [...items].sort((left, right) => compareText(left.id, right.id)).map((item) => [
    `### ${code(item.id)}`,
    "",
    `- Statement: ${escapeMarkdown(item.statement)}`,
    `- Confidence: ${code(item.confidence)}`,
    `- Evidence IDs: ${list(item.evidenceIds)}`,
    `- Source paths: ${list(item.sourcePaths)}`,
    `- Reason codes: ${list(item.reasonCodes)}`,
    `- Selection reason: ${escapeMarkdown(item.selectionReason)}`
  ].join("\n")).join("\n\n");
}

function renderUnresolved(items: readonly UnresolvedContextItem[]): string {
  if (items.length === 0) return "_None._";
  return [...items].sort((left, right) => compareText(left.id, right.id)).map((item) => [
    `### ${code(item.id)}`,
    "",
    `- Candidate IDs: ${list(item.candidateIds)}`,
    `- Statement: ${escapeMarkdown(item.statement)}`,
    `- Evidence IDs: ${list(item.evidenceIds)}`,
    `- Source paths: ${list(item.sourcePaths)}`,
    `- Reason codes: ${list(item.reasonCodes)}`,
    `- Explanation: ${escapeMarkdown(item.explanation)}`
  ].join("\n")).join("\n\n");
}

function renderEvidenceMap(contract: TaskContextContract): string {
  const selected = [
    ...contract.relevantArchitecture,
    ...contract.requirements,
    ...contract.constraints,
    ...contract.relevantFiles,
    ...contract.protectedFiles
  ].map((item) => ({ id: item.id, evidenceIds: item.evidenceIds, sourcePaths: item.sourcePaths }));
  const unresolved = contract.unresolvedDecisions.map((item) => ({ id: item.id, evidenceIds: item.evidenceIds, sourcePaths: item.sourcePaths }));
  const entries = [...selected, ...unresolved].sort((left, right) => compareText(left.id, right.id));
  if (entries.length === 0) return "_None._";
  return entries.map((entry) => [
    `- ${code(entry.id)}`,
    `  - Evidence IDs: ${list(entry.evidenceIds)}`,
    `  - Source paths: ${list(entry.sourcePaths)}`
  ].join("\n")).join("\n");
}

export function renderContextContract(contract: TaskContextContract): string {
  const sections = [
    "# Camarade Task Context",
    "",
    "## Task",
    "",
    escapeMarkdown(contract.task.originalTask),
    "",
    "## Goal",
    "",
    escapeMarkdown(contract.goal),
    "",
    "## Repository Summary",
    "",
    bulletList(contract.repositorySummary),
    "",
    "## Relevant Architecture",
    "",
    renderItems(contract.relevantArchitecture),
    "",
    "## Requirements",
    "",
    renderItems(contract.requirements),
    "",
    "## Constraints",
    "",
    renderItems(contract.constraints),
    "",
    "## Relevant Files",
    "",
    renderItems(contract.relevantFiles),
    "",
    "## Protected Files",
    "",
    renderItems(contract.protectedFiles),
    "",
    "## Validation Commands",
    "",
    contract.validationCommands.length === 0 ? "_None._" : uniqueSorted(contract.validationCommands).map((command) => `- ${code(command)}`).join("\n"),
    "",
    "## Unresolved Decisions",
    "",
    renderUnresolved(contract.unresolvedDecisions),
    "",
    "## Evidence Map",
    "",
    renderEvidenceMap(contract)
  ];
  return `${sections.join("\n")}\n`;
}

export function measureContextContractCharacters(markdown: string): number {
  return characterCount(markdown);
}
