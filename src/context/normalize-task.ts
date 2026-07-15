import { ContextCompilationError } from "../core/errors.js";
import type { TaskOperation, TaskSpecification } from "./context-types.js";
import { isSafeRepositoryPath, toPosixPath } from "./context-serialization.js";

const OPERATION_PATTERNS: ReadonlyArray<readonly [TaskOperation, RegExp]> = [
  ["add", /\b(?:add|build|create|implement|introduce)\b/iu],
  ["fix", /\b(?:correct|debug|fix|patch|repair|resolve)\b/iu],
  ["refactor", /\b(?:refactor|restructure|reorganize)\b/iu],
  ["test", /\b(?:test|tests|testing)\b/iu],
  ["document", /\b(?:docs?|document|documentation|readme)\b/iu],
  ["investigate", /\b(?:analy[sz]e|audit|diagnose|inspect|investigate|why)\b/iu]
];

const DOMAIN_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["api", /\b(?:api|endpoint|http|route handler|route)\b/iu],
  ["security", /\b(?:auth(?:entication|orization)?|permission|rate[-\s]+limit(?:ing)?|secur(?:e|ity))\b/iu],
  ["rate-limiting", /\brate[-\s]+limit(?:ing)?\b/iu],
  ["frontend", /\b(?:accessibility|component|css|design system|frontend|html|react|ui|ux|view)\b/iu],
  ["backend", /\b(?:backend|controller|middleware|server|service)\b/iu],
  ["database", /\b(?:database|migration|query|schema|sql)\b/iu],
  ["testing", /\b(?:assertion|spec|test|tests|testing|vitest|jest)\b/iu],
  ["documentation", /\b(?:docs?|document|documentation|readme)\b/iu],
  ["configuration", /\b(?:config|configuration|environment|yaml)\b/iu],
  ["performance", /\b(?:cache|latency|performance|profil(?:e|ing)|throughput)\b/iu]
];

const PROHIBITION = /\b(?:avoid|do not|don't|leave\b[^.!?;]*\bunchanged|must not|never|no changes? to|should not|without (?:changing|editing|modifying|touching))\b/iu;
const ACCEPTANCE = /^(?:(?:and|but)\s+)?(?:acceptance(?: criteria)?|done when|ensure(?: that)?|success(?: criteria)?|verify(?: that)?)\b|\b(?:tests?|typecheck|validation)\s+(?:all\s+)?(?:must|should)\s+pass\b/iu;
const ACTIONABLE = /\b(?:add|analy[sz]e|audit|build|change|configure|correct|create|debug|delete|diagnose|disable|document|enable|enforce|fix|implement|inspect|introduce|investigate|migrate|modify|move|optimi[sz]e|patch|refactor|remove|rename|repair|replace|resolve|restructure|reorganize|support|test|update|upgrade|verify|why|write)\b/iu;

const STOP_WORDS = new Set([
  "a", "add", "all", "an", "and", "application", "as", "at", "be", "build", "by", "can",
  "change", "code", "configure", "create", "do", "document", "enable", "ensure", "fix", "for",
  "from", "implement", "in", "inspect", "introduce", "investigate", "it", "make", "modify", "of",
  "must", "never", "not", "on", "or", "our", "pass", "please", "project", "refactor", "repository", "repo", "should", "something",
  "stuff", "support", "task", "test", "tests", "that", "the", "this", "to", "update", "verify",
  "we", "with", "without", "work", "write", "you", "your"
]);

const GENERIC_CONTENT = new Set([
  "app", "application", "better", "change", "code", "issue", "it", "project", "repo", "repository",
  "something", "stuff", "task", "that", "things", "this"
]);

function fail(message: string, reason: string): never {
  throw new ContextCompilationError(
    message,
    "CONTEXT_REQUEST_INVALID",
    "normalize-task",
    { reason }
  );
}

function normalizedWhitespace(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

function sentenceClauses(value: string): string[] {
  const clauses: string[] = [];
  let start = 0;
  for (const match of value.matchAll(/[.!?;]+(?=\s|$)/gu)) {
    const end = (match.index ?? 0) + match[0].length;
    const clause = value.slice(start, end).trim();
    if (clause !== "") clauses.push(clause);
    start = end;
    while (value[start] === " ") start += 1;
  }
  const tail = value.slice(start).trim();
  if (tail !== "") clauses.push(tail);

  return clauses.flatMap((clause) => clause
    .split(/(?<!\band)(?<!\bbut)\s+(?=(?:(?:and|but)\s+)?(?:acceptance(?: criteria)?|do not|don't|done when|ensure(?: that)?|must not|never|success(?: criteria)?|verify(?: that)?))/giu)
    .map((part) => part.trim())
    .filter((part) => part !== ""));
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function operation(value: string): TaskOperation {
  let selected: { operation: TaskOperation; index: number; order: number } | undefined;
  OPERATION_PATTERNS.forEach(([candidate, pattern], order) => {
    const match = pattern.exec(value);
    if (match === null) return;
    const current = { operation: candidate, index: match.index, order };
    if (selected === undefined || current.index < selected.index ||
      current.index === selected.index && current.order < selected.order) selected = current;
  });
  return selected?.operation ?? "unknown";
}

function pathCandidate(raw: string): string | undefined {
  let value = raw.trim()
    .replace(/^[`'"([{<]+/u, "")
    .replace(/[`'"\])}>;,.!?]+$/u, "")
    .replace(/:\d+(?::\d+)?$/u, "")
    .replaceAll("\\", "/");
  if (value.startsWith("./")) value = value.slice(2);
  if (value === "" || /\s/u.test(value) || /^[a-z][a-z\d+.-]*:\/\//iu.test(value) || /[*?\[\]]/u.test(value)) {
    return undefined;
  }
  const looksLikePath = value.includes("/") || value.startsWith(".") ||
    /^(?:AGENTS|CLAUDE|README)\.md$/iu.test(value) ||
    /\.(?:cjs|css|html|js|json|jsx|md|mdx|mjs|sql|ts|tsx|txt|yaml|yml)$/iu.test(value);
  const posix = toPosixPath(value);
  return looksLikePath && isSafeRepositoryPath(posix) && posix !== "<task>" ? posix : undefined;
}

function explicitPaths(value: string): string[] {
  const matches: string[] = [];
  for (const quoted of value.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/gu)) {
    const path = pathCandidate(quoted[1] ?? quoted[2] ?? quoted[3] ?? "");
    if (path !== undefined) matches.push(path);
  }
  for (const token of value.split(/\s+/u)) {
    const path = pathCandidate(token);
    if (path !== undefined) matches.push(path);
  }
  return uniqueInOrder(matches);
}

function keywords(value: string, paths: readonly string[]): string[] {
  const found: string[] = [];
  const quotedRanges: Array<readonly [number, number]> = [];
  for (const match of value.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/gu)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const path = pathCandidate(raw);
    if (path === undefined && /^[\p{L}_$][\p{L}\p{N}_.:$-]*$/u.test(raw)) found.push(raw);
    quotedRanges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }
  let searchable = value;
  for (const [start, end] of [...quotedRanges].reverse()) {
    searchable = `${searchable.slice(0, start)}${" ".repeat(end - start)}${searchable.slice(end)}`;
  }
  for (const path of paths) searchable = searchable.split(path).join(" ");
  const tokens = searchable.toLowerCase().match(/rate[-\s]+limiting|[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  for (const raw of tokens) {
    const token = /^rate[-\s]+limiting$/u.test(raw) ? "rate limiting" : raw;
    if (token.length < 2 || STOP_WORDS.has(token)) continue;
    found.push(token);
  }
  const seen = new Set<string>();
  return found.filter((value) => {
    const key = value.toLocaleLowerCase("en-US");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasConcreteIntent(value: string, paths: readonly string[], taskKeywords: readonly string[]): boolean {
  if (!ACTIONABLE.test(value) && !PROHIBITION.test(value)) return false;
  if (paths.length > 0) return true;
  const content = taskKeywords
    .flatMap((keyword) => keyword.toLowerCase().split(/[^a-z0-9]+/u))
    .filter((token) => token.length >= 2 && !GENERIC_CONTENT.has(token));
  return content.length > 0;
}

export function normalizeTask(task: string): TaskSpecification {
  if (typeof task !== "string") fail("Task must be a string.", "task-not-string");
  const normalizedTask = normalizedWhitespace(task);
  if (normalizedTask === "") fail("Task must not be empty or whitespace-only.", "task-empty");

  const paths = explicitPaths(normalizedTask);
  const taskKeywords = keywords(normalizedTask, paths);
  if (!hasConcreteIntent(normalizedTask, paths, taskKeywords)) {
    fail("Task intent is ambiguous; provide an action and a concrete target.", "task-ambiguous");
  }

  const clauses = sentenceClauses(normalizedTask);
  const explicitProhibitions = uniqueInOrder(clauses.filter((clause) => PROHIBITION.test(clause)));
  const acceptanceHints = uniqueInOrder(clauses.filter((clause) => !PROHIBITION.test(clause) && ACCEPTANCE.test(clause)));
  const explicitRequirements = uniqueInOrder(clauses.filter((clause) =>
    !PROHIBITION.test(clause) && !ACCEPTANCE.test(clause)));

  return {
    originalTask: task,
    normalizedTask,
    operation: operation(explicitRequirements.join(" ")),
    domains: DOMAIN_PATTERNS.filter(([, pattern]) => pattern.test(normalizedTask)).map(([domain]) => domain),
    keywords: taskKeywords,
    explicitPaths: paths,
    explicitRequirements,
    explicitProhibitions,
    acceptanceHints
  };
}
