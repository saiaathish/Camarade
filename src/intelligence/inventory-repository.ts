import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { DegradationCode } from "../core/types.js";
import type { RepositoryFact, RepositoryFile, RepositoryFileKind, RepositoryInventory, RepositoryInventorySkip, RepositoryRule, RelevantFileCandidate, RepositoryLanguage } from "./model.js";
import { createStableId } from "./stable-id.js";

export const MAX_REPOSITORY_FILES = 100_000;
export const MAX_INVENTORY_FILE_BYTES = 1024 * 1024;
export const MAX_INVENTORY_TOTAL_BYTES = 256 * 1024 * 1024;
const ignored = new Set([".git", "node_modules", "dist", "coverage", ".camarade"]);
const skip = { link: "Symbolic links are not followed.", size: "File exceeds inventory size limit.", binary: "Binary file content is not analyzed.", unreadable: "File content could not be read." };
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const posix = (p: string) => p.split(path.sep).join("/");
const ext = (p: string) => path.extname(p).toLowerCase();
const language = (p: string): RepositoryLanguage => [".ts", ".tsx"].includes(ext(p)) ? "typescript" : [".js", ".jsx", ".mjs", ".cjs"].includes(ext(p)) ? "javascript" : ext(p) === ".json" ? "json" : [".yaml", ".yml"].includes(ext(p)) ? "yaml" : [".md", ".mdx"].includes(ext(p)) ? "markdown" : "other";
const kind = (p: string): RepositoryFileKind => { const l = p.toLowerCase(); const base = path.posix.basename(l); if (base === "agents.md" || base === "claude.md" || base === "copilot-instructions.md" && l.startsWith(".github/") || l.startsWith(".cursor/rules/")) return "instruction"; if (language(p) === "markdown" || l.startsWith("docs/")) return "documentation"; if (base === "package.json" || [".json", ".yaml", ".yml"].includes(ext(p))) return "configuration"; if (["tests/", "test/", "__tests__/"].some(x => l.startsWith(x)) || l.includes(".test.") || l.includes(".spec.")) return "test"; if (["typescript", "javascript"].includes(language(p))) return "source"; return "other"; };
const lineOf = (source: string, n: number) => source.slice(0, n).split("\n").length;
const excerpt = (source: string, node: ts.Node) => source.slice(node.getStart(), node.getEnd()).replace(/\s+/g, " ").trim().slice(0, 240);
function fact(kindName: RepositoryFact["kind"], rel: string, source: string, node: ts.Node, subject: string, value: string): RepositoryFact { const startLine = lineOf(source, node.getStart()), endLine = lineOf(source, node.getEnd()), text = excerpt(source, node), excerptHash = sha256(text); return { id: createStableId("fact", [kindName, rel, startLine, endLine, subject, value, excerptHash]), kind: kindName, relativePath: rel, startLine, endLine, subject, value, excerpt: text, excerptHash }; }
function codeFacts(rel: string, source: string, file: RepositoryFile): RepositoryFact[] { const out: RepositoryFact[] = []; const script = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, [".tsx", ".jsx"].includes(ext(rel)) ? ts.ScriptKind.TSX : [".js", ".jsx", ".mjs", ".cjs"].includes(ext(rel)) ? ts.ScriptKind.JS : ts.ScriptKind.TS); const add = (k: RepositoryFact["kind"], n: ts.Node, s: string, v: string) => out.push(fact(k, rel, source, n, s, v));
  const isExported = (n: ts.Node) => !!(ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Export);
  const visit = (n: ts.Node) => { if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) { add("import", n, "module", n.moduleSpecifier.text); if (n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)) for (const x of n.importClause.namedBindings.elements) if (/middleware/i.test(x.name.text)) add("middleware-reference", x, x.name.text, n.moduleSpecifier.text); if (/middleware/i.test(n.moduleSpecifier.text)) add("middleware-reference", n, "module", n.moduleSpecifier.text); }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) add("import", n, "module", n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && n.arguments.length === 1 && ts.isStringLiteral(n.arguments[0])) { if (n.expression.getText(script) === "require") add("import", n, "module", n.arguments[0].text); if (n.expression.kind === ts.SyntaxKind.ImportKeyword) add("import", n, "module", n.arguments[0].text); }
    if (isExported(n) && (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n))) { const name = n.name?.getText(script) ?? "default"; add("export", n, name, name); if (ts.isFunctionDeclaration(n) && /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(name)) add("route-handler", n, name, name); }
    if (isExported(n) && ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) add("export", d, d.name.text, d.name.text);
    if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause)) for (const x of n.exportClause.elements) add("export", x, x.name.text, x.propertyName?.text ?? x.name.text);
    if (ts.isFunctionLike(n)) { const body = (n as unknown as { body?: ts.ConciseBody }).body; if (body && ts.isBlock(body) && body.statements.length && ts.isExpressionStatement(body.statements[0]) && ts.isStringLiteral(body.statements[0].expression) && body.statements[0].expression.text === "use server") add("server-action", body.statements[0], "use server", "function"); }
    ts.forEachChild(n, visit); }; ts.forEachChild(script, visit); if (script.statements[0] && ts.isExpressionStatement(script.statements[0]) && ts.isStringLiteral(script.statements[0].expression) && script.statements[0].expression.text === "use server") add("server-action", script.statements[0], "use server", "module"); return out;
}
export class RepositoryInventoryError extends Error {
  constructor(message: string, readonly code: DegradationCode) {
    super(message);
    this.name = "RepositoryInventoryError";
  }
}

export function enforceRepositoryFileLimit(fileCount: number, limit = MAX_REPOSITORY_FILES): void {
  if (!Number.isSafeInteger(fileCount) || fileCount < 0 || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError("Repository file counts and limits must be non-negative and positive safe integers.");
  }
  if (fileCount > limit) {
    throw new RepositoryInventoryError(
      `Repository contains more than the ${limit}-file analysis limit.`,
      "REPOSITORY_TOO_LARGE"
    );
  }
}

interface InventoryEntry { fullPath: string; relativePath: string; sizeBytes?: number; }

async function enumerate(
  root: string,
  current: string,
  directories: string[],
  entries: InventoryEntry[],
  skipped: RepositoryInventorySkip[]
): Promise<void> {
  const children = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    const fullPath = path.join(current, child.name);
    const relativePath = posix(path.relative(root, fullPath));
    if (child.isSymbolicLink()) {
      skipped.push({ relativePath, reason: skip.link });
      continue;
    }
    if (child.isDirectory()) {
      if (!ignored.has(child.name)) {
        directories.push(relativePath);
        await enumerate(root, fullPath, directories, entries, skipped);
      }
      continue;
    }
    if (!child.isFile()) continue;
    entries.push({ fullPath, relativePath });
    enforceRepositoryFileLimit(entries.length);
  }
}

async function inspectEntrySizes(entries: InventoryEntry[], skipped: RepositoryInventorySkip[]): Promise<InventoryEntry[]> {
  const analyzable: InventoryEntry[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    let fileStat;
    try {
      fileStat = await fs.stat(entry.fullPath);
    } catch {
      skipped.push({ relativePath: entry.relativePath, reason: skip.unreadable });
      continue;
    }
    if (!fileStat.isFile()) continue;
    if (fileStat.size > MAX_INVENTORY_FILE_BYTES) {
      skipped.push({ relativePath: entry.relativePath, reason: skip.size, code: "REPOSITORY_TOO_LARGE" });
      continue;
    }
    totalBytes += fileStat.size;
    if (totalBytes > MAX_INVENTORY_TOTAL_BYTES) {
      throw new RepositoryInventoryError(
        `Repository analyzable content exceeds the ${MAX_INVENTORY_TOTAL_BYTES}-byte total limit.`,
        "REPOSITORY_TOO_LARGE"
      );
    }
    analyzable.push({ ...entry, sizeBytes: fileStat.size });
  }
  return analyzable;
}

async function analyzeEntry(
  entry: InventoryEntry,
  files: RepositoryFile[],
  facts: RepositoryFact[],
  skipped: RepositoryInventorySkip[]
): Promise<void> {
  let data: Buffer;
  try {
    data = await fs.readFile(entry.fullPath);
  } catch {
    skipped.push({ relativePath: entry.relativePath, reason: skip.unreadable });
    return;
  }
  if (data.length > MAX_INVENTORY_FILE_BYTES) {
    skipped.push({ relativePath: entry.relativePath, reason: skip.size, code: "REPOSITORY_TOO_LARGE" });
    return;
  }
  const rel = entry.relativePath;
  const digest = sha256(data);
  const file: RepositoryFile = {
    id: createStableId("file", [rel, digest]),
    relativePath: rel,
    kind: kind(rel),
    language: language(rel),
    sizeBytes: entry.sizeBytes ?? data.length,
    sha256: digest
  };
  files.push(file);
  facts.push(fact("file-exists", rel, rel, { getStart: () => 0, getEnd: () => rel.length } as ts.Node, "file", "exists"));
  if (data.subarray(0, 8192).includes(0)) {
    skipped.push({ relativePath: rel, reason: skip.binary });
    return;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    skipped.push({ relativePath: rel, reason: "File content is not valid UTF-8.", code: "UNSUPPORTED_ENCODING" });
    return;
  }
  if (rel === "package.json") {
    try {
      const pkg = JSON.parse(text);
      for (const [name, value] of Object.entries(pkg.scripts ?? {})) facts.push(fact("package-script", rel, text, { getStart: () => 0, getEnd: () => text.length } as ts.Node, `scripts.${name}`, String(value)));
      for (const [section, factKind] of [["dependencies", "dependency"], ["devDependencies", "dev-dependency"]] as const) {
        for (const [name, value] of Object.entries(pkg[section] ?? {})) facts.push(fact(factKind, rel, text, { getStart: () => 0, getEnd: () => text.length } as ts.Node, name, String(value)));
      }
      for (const name of ["next", "react", "vue", "svelte", "express", "fastify", "nestjs", "@nestjs/core"]) if (pkg.dependencies?.[name] || pkg.devDependencies?.[name]) facts.push(fact("framework", rel, text, { getStart: () => 0, getEnd: () => text.length } as ts.Node, name, name));
      for (const name of ["vitest", "jest", "mocha", "ava"]) if (pkg.dependencies?.[name] || pkg.devDependencies?.[name]) facts.push(fact("test-framework", rel, text, { getStart: () => 0, getEnd: () => text.length } as ts.Node, name, name));
    } catch {
      skipped.push({ relativePath: rel, reason: skip.unreadable });
    }
  }
  if (["typescript", "javascript"].includes(file.language)) facts.push(...codeFacts(rel, text, file));
}

export async function inventoryRepository(repositoryPath: string): Promise<RepositoryInventory> {
  if (!repositoryPath.trim()) throw new Error("Repository path is empty.");
  let root: string;
  try { root = await fs.realpath(repositoryPath); }
  catch { throw new Error(`Repository path does not exist or cannot be resolved: ${repositoryPath}`); }
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) throw new Error(`Repository path is not a directory: ${repositoryPath}`);
  const directories: string[] = [];
  const entries: InventoryEntry[] = [];
  const files: RepositoryFile[] = [];
  const facts: RepositoryFact[] = [];
  const skipped: RepositoryInventorySkip[] = [];
  await enumerate(root, root, directories, entries, skipped);
  const analyzableEntries = await inspectEntrySizes(entries, skipped);
  for (const entry of analyzableEntries) await analyzeEntry(entry, files, facts, skipped);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  facts.sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.startLine - b.startLine || a.id.localeCompare(b.id));
  return {
    directories: directories.sort(),
    files,
    facts,
    skipped: skipped.sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.reason.localeCompare(b.reason))
  };
}
const stop = new Set("the and for with from that this task repository file files src test tests all into are can use not to of in on a an as by or is be do at it we our your only when".split(" "));
const tokens = (s: string) => [...new Set(s.toLowerCase().split(/[^a-z0-9@._/-]+/).filter(x => x.length >= 3 && !stop.has(x)))];
export function rankRelevantFiles(inventory: RepositoryInventory, task: string, rules: readonly RepositoryRule[] = []): RelevantFileCandidate[] { const ts = tokens(task); if (!ts.length) return []; const nonTest = new Set(inventory.files.filter(f => f.kind !== "test").map(f => path.posix.basename(f.relativePath).replace(/\.(test|spec)(?=\.)/g, "").replace(/\.(tsx?|jsx?|mjs|cjs)$/, ""))); const out: RelevantFileCandidate[] = []; for (const file of inventory.files) { const reasons: string[] = [], support: string[] = [], pathHits = ts.filter(t => file.relativePath.toLowerCase().includes(t)); let score = Math.min(50, new Set(pathHits).size * 25); if (score) reasons.push(`path match: ${[...new Set(pathHits)].join(", ")} (+${score})`); const fs = inventory.facts.filter(f => f.relativePath === file.relativePath), hitFacts = fs.filter(f => ts.some(t => `${f.subject} ${f.value}`.toLowerCase().includes(t))); const factHits = [...new Set(hitFacts.flatMap(f => ts.filter(t => `${f.subject} ${f.value}`.toLowerCase().includes(t))))]; const factScore = Math.min(30, factHits.length * 10); score += factScore; if (factScore) { reasons.push(`fact match: ${factHits.join(", ")} (+${factScore})`); support.push(...hitFacts.map(f => f.id)); } if (rules.some(r => r.statement.includes(file.relativePath) || r.scope.include.includes(file.relativePath))) { score += 20; reasons.push("rule path support (+20)"); } const base = path.posix.basename(file.relativePath).replace(/\.(test|spec)(?=\.)/g, "").replace(/\.(tsx?|jsx?|mjs|cjs)$/, ""); if (file.kind === "test" && score > 0 && nonTest.has(base)) { score += 15; reasons.push("test counterpart (+15)"); } score = Math.min(100, score); if (score) out.push({ relativePath: file.relativePath, score, reasons, supportingFactIds: [...new Set(support)].sort() }); } return out.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath)); }
