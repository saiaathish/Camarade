import type { RuleScope } from "./model.js";

const technologies = ["nextjs", "next.js", "react", "typescript", "javascript", "node", "node.js", "express", "fastify", "vitest", "jest"];
const techCanonical = (value: string): string => value.toLowerCase() === "next.js" ? "nextjs" : value.toLowerCase() === "node.js" ? "node" : value.toLowerCase();
const sort = (values: readonly string[]): string[] => [...new Set(values)].sort();
const pathPattern = /(?:`[^`]+`|"[^"]+"|'[^']+'|(?:^|\s)(?:\.?\.?(?:\/|\\))[^\s,;:]+|(?:^|\s)[\w./\\-]+\.(?:ts|tsx|js|jsx|json|yaml|yml|md)(?:\b|$)|(?:^|\s)[\w./\\-]*\*[^\s,;:]+)/gi;
const cleanPath = (value: string): string | undefined => {
  let path = value.trim().replace(/^['"`]|['"`]$/g, "").replace(/[.,;:!?]+$/, "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return undefined;
  if (!(/[/.]/.test(path) || path.includes("*") || path.startsWith("."))) return undefined;
  return path;
};

const instructionSubtree = (sourceRelativePath: string): string | undefined => {
  const normalized = sourceRelativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const name = normalized.split("/").at(-1)?.toLowerCase();
  if (name !== "agents.md" && name !== "claude.md") return undefined;
  const directory = normalized.slice(0, Math.max(0, normalized.lastIndexOf("/")));
  return directory === "" ? undefined : directory;
};

const constrainToSubtree = (candidate: string, subtree: string | undefined): string => {
  if (subtree === undefined) return candidate;
  if (candidate === subtree || candidate.startsWith(`${subtree}/`)) return candidate;
  return `${subtree}/${candidate}`;
};

export interface ResolveRuleScopeInput { statement: string; sourceRelativePath: string; }

export function resolveRuleScope(input: ResolveRuleScopeInput): RuleScope {
  const statement = input.statement;
  const subtree = instructionSubtree(input.sourceRelativePath);
  const include: string[] = [subtree === undefined ? "**/*" : `${subtree}/**`];
  const exclusions: string[] = [];
  const exclusionMatch = statement.match(/\b(?:except|unless|excluding|does not apply to)\b([\s\S]*)/i);
  if (exclusionMatch && !/\bonly\s+for\b/i.test(exclusionMatch[0])) {
    pathPattern.lastIndex = 0;
    for (const match of exclusionMatch[1].matchAll(pathPattern)) {
      const path = cleanPath(match[0]);
      if (path) exclusions.push(constrainToSubtree(path, subtree));
    }
  }
  pathPattern.lastIndex = 0;
  const included = [...statement.matchAll(pathPattern)].map((m) => cleanPath(m[0])).filter((p): p is string => !!p);
  const specific = included
    .map((path) => constrainToSubtree(path, subtree))
    .filter((p) => !exclusions.includes(p) && !technologies.some((tech) => tech.toLowerCase() === p.toLowerCase()));
  const finalInclude = specific.length ? specific : include;
  const lower = statement.toLowerCase();
  const foundTech = technologies.filter((tech) => new RegExp(`\\b${tech.replace(".", "\\.")}\\b`, "i").test(lower)).map(techCanonical);
  const pathTokens = new Set([...included, ...exclusions].flatMap((p) => p.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/)));
  const stop = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "use", "must", "should", "prefer", "avoid", "only", "not", "does", "apply", "to", "in", "on", "under", "a", "an"]);
  const taskKeywords = sort(lower.replace(/[`"']/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !stop.has(w) && !foundTech.includes(techCanonical(w)) && !pathTokens.has(w))).slice(0, 12);
  const exceptionText = exclusionMatch?.[1].toLowerCase().replace(/[.,;:!?]+$/, "").replace(/\s+/g, " ").trim();
  pathPattern.lastIndex = 0;
  const exceptionHasPath = exceptionText ? pathPattern.test(exceptionText) : false;
  pathPattern.lastIndex = 0;
  const exceptionWords = exceptionText && !exceptionHasPath ? [`exception:${exceptionText}`] : [];
  return { include: sort(finalInclude), exclude: sort(exclusions), technologies: sort(foundTech), taskKeywords: sort([...taskKeywords, ...exceptionWords]) };
}
