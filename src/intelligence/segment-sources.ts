import { createHash } from "node:crypto";
import type { ContextSource } from "../core/types.js";
import type { SourceSegment } from "./model.js";
import { createStableId } from "./stable-id.js";

export interface SegmentSourcesResult {
  segments: SourceSegment[];
  skipped: Array<{ relativePath: string; reason: string }>;
}

const directives = /\b(?:must(?:\s+not)?|never|always|should(?:\s+not)?|prefer|avoid|use|do\s+not(?:\s+use)?|only|except|unless)\b/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const normalize = (value: string) => value.replace(/\r\n?/g, "\n");
const lineIsBlank = (line: string) => line.trim() === "";
const heading = (line: string) => /^#{1,6}\s/.test(line);
const fence = (line: string) => /^\s*(`{3,}|~{3,})/.exec(line);
const list = (line: string) => /^\s*(?:[-*+] |\d+\. )/.test(line);
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function makeSegment(sourceId: string, kind: SourceSegment["kind"], start: number, lines: string[]): SourceSegment {
  const rawExcerpt = lines.join("\n");
  const normalizedText = rawExcerpt.trim();
  const excerptHash = hash(rawExcerpt);
  return { id: createStableId("segment", [sourceId, kind, start, start + lines.length - 1, excerptHash]), sourceId, kind, startLine: start, endLine: start + lines.length - 1, rawExcerpt, normalizedText, excerptHash };
}

function markdown(sourceId: string, lines: string[]): SourceSegment[] {
  const result: SourceSegment[] = [];
  for (let i = 0; i < lines.length;) {
    if (lineIsBlank(lines[i])) { i++; continue; }
    const opening = fence(lines[i]);
    if (opening) {
      const marker = opening[1][0]; let end = i;
      while (++end < lines.length && !new RegExp(`^\\s*${marker}{${opening[1].length},}\\s*$`).test(lines[end])) {}
      if (end >= lines.length) end = lines.length - 1;
      result.push(makeSegment(sourceId, "code-block", i + 1, lines.slice(i, end + 1))); i = end + 1; continue;
    }
    if (heading(lines[i])) { result.push(makeSegment(sourceId, "heading", i + 1, [lines[i]])); i++; continue; }
    if (list(lines[i])) {
      const start = i; i++;
      while (i < lines.length && /^\s/.test(lines[i]) && !lineIsBlank(lines[i]) && !heading(lines[i]) && !list(lines[i]) && !fence(lines[i])) i++;
      const text = lines.slice(start, i).join("\n"); result.push(makeSegment(sourceId, directives.test(text) ? "directive" : "list-item", start + 1, lines.slice(start, i))); continue;
    }
    const start = i; i++;
    while (i < lines.length && !lineIsBlank(lines[i]) && !heading(lines[i]) && !list(lines[i]) && !fence(lines[i])) i++;
    const part = lines.slice(start, i); result.push(makeSegment(sourceId, directives.test(part.join("\n")) ? "directive" : "paragraph", start + 1, part));
  }
  return result;
}

function jsonSegments(source: ContextSource, lines: string[]): { segments: SourceSegment[]; invalid: boolean } {
  try { JSON.parse(source.content); } catch { return { segments: [], invalid: true }; }
  const result: SourceSegment[] = [];
  const text = lines.join("\n");
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"\s*:/g; let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    let depth = 0; let quoted = false; let escaped = false;
    for (const character of text.slice(0, match.index)) {
      if (escaped) { escaped = false; continue; } if (character === "\\" && quoted) { escaped = true; continue; }
      if (character === '"') quoted = !quoted; else if (!quoted && character === "{") depth++; else if (!quoted && character === "}") depth--;
    }
    if (depth !== 1) continue;
    const before = text.slice(0, match.index); const start = before.split("\n").length - 1;
    const keyPos = match.index - (before.lastIndexOf("\n") + 1);
    if (keyPos < 0) continue;
    let end = start; const value = text.slice(match.index + match[0].length); const open = value.search(/[\[{]/);
    if (open >= 0 && value.slice(0, open).trim() === "") {
      const stack: string[] = []; let quotedValue = false; let escapedValue = false; let closeAt = value.length - 1;
      for (let p = open; p < value.length; p++) {
        const character = value[p];
        if (escapedValue) { escapedValue = false; continue; }
        if (character === "\\" && quotedValue) { escapedValue = true; continue; }
        if (character === '"') { quotedValue = !quotedValue; continue; }
        if (quotedValue) continue;
        if (character === "{" || character === "[") stack.push(character === "{" ? "}" : "]");
        else if (character === stack[stack.length - 1]) { stack.pop(); if (!stack.length) { closeAt = p; break; } }
      }
      end = start + value.slice(0, closeAt + 1).split("\n").length - 1;
    }
    result.push(makeSegment(createStableId("source", [source.relativePath, source.sha256]), "configuration-entry", start + 1, lines.slice(start, end + 1)));
  }
  return { segments: result, invalid: false };
}

function yamlSegments(sourceId: string, lines: string[]): SourceSegment[] {
  const result: SourceSegment[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^[^\s#][^:]*:\s*(?:.*)?$/.test(lines[i]) || /^(?:---|\.\.\.)\s*$/.test(lines[i])) continue;
    const start = i; i++;
    while (i < lines.length && !/^[^\s#][^:]*:\s*(?:.*)?$/.test(lines[i]) && !/^(?:---|\.\.\.)\s*$/.test(lines[i])) i++;
    const block = lines.slice(start, i);
    if (block.some((line) => !lineIsBlank(line))) result.push(makeSegment(sourceId, "configuration-entry", start + 1, block));
    i--;
  }
  return result;
}

export function segmentContextSources(sources: readonly ContextSource[]): SegmentSourcesResult {
  const segments: SourceSegment[] = []; const skipped: SegmentSourcesResult["skipped"] = [];
  for (const source of [...sources].sort((a, b) => compareText(a.relativePath, b.relativePath))) {
    const lines = normalize(source.content).split("\n"); const sourceId = createStableId("source", [source.relativePath, source.sha256]); const path = source.relativePath.toLowerCase();
    if (path.endsWith(".json")) { const parsed = jsonSegments(source, lines); if (parsed.invalid) skipped.push({ relativePath: source.relativePath, reason: "Invalid JSON configuration." }); else segments.push(...parsed.segments); }
    else if (path.endsWith(".yaml") || path.endsWith(".yml")) { const found = yamlSegments(sourceId, lines); if (!found.length) skipped.push({ relativePath: source.relativePath, reason: "No supported YAML configuration entries found." }); else segments.push(...found); }
    else if (path.endsWith(".md")) segments.push(...markdown(sourceId, lines));
    else lines.forEach((line, i) => { if (!lineIsBlank(line)) segments.push(makeSegment(sourceId, "source-code-fact", i + 1, [line])); });
  }
  segments.sort((a, b) => compareText(a.sourceId, b.sourceId) || a.startLine - b.startLine || a.endLine - b.endLine || compareText(a.id, b.id)); skipped.sort((a, b) => compareText(a.relativePath, b.relativePath));
  return { segments, skipped };
}
