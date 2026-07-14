import { describe, expect, it } from "vitest";
import { segmentContextSources } from "../src/intelligence/segment-sources.js";
import type { ContextSource } from "../src/core/types.js";

const source = (relativePath: string, content: string, absolutePath = "/tmp/a") => ({ relativePath, absolutePath, kind: "docs", content, sha256: "a".repeat(64) }) as ContextSource;

describe("segmentContextSources", () => {
  it("produces an explicit paragraph segment", () => {
    const result = segmentContextSources([source("notes.md", "first line\nsecond line")]);
    expect(result.segments).toMatchObject([{ kind: "paragraph", startLine: 1, endLine: 2, rawExcerpt: "first line\nsecond line" }]);
  });
  it("treats CRLF and LF sources equivalently", () => {
    const lf = segmentContextSources([source("notes.md", "# Title\n\nplain text")]);
    const crlf = segmentContextSources([source("notes.md", "# Title\r\n\r\nplain text")]);
    expect(crlf).toEqual(lf);
  });
  it("segments markdown with one-based lines, normalization, directives, lists, and fences", () => {
    const result = segmentContextSources([source("README.md", "# Title\r\n\r\nMust never lose\r\nline two\r\n\r\n- one\r\n  continuation\r\n\r\n```ts\r\nuse x\r\n```\r\n")]);
    expect(result.skipped).toEqual([]);
    expect(result.segments.map(({ kind, startLine, endLine, rawExcerpt }) => ({ kind, startLine, endLine, rawExcerpt }))).toEqual([
      { kind: "heading", startLine: 1, endLine: 1, rawExcerpt: "# Title" },
      { kind: "directive", startLine: 3, endLine: 4, rawExcerpt: "Must never lose\nline two" },
      { kind: "list-item", startLine: 6, endLine: 7, rawExcerpt: "- one\n  continuation" },
      { kind: "code-block", startLine: 9, endLine: 11, rawExcerpt: "```ts\nuse x\n```" }
    ]);
  });
  it("handles unclosed fences without inner segments and generic lines", () => {
    const result = segmentContextSources([source("x.md", "```\n# not heading\nuse not paragraph"), source("x.ts", "\nconst x = 1\n\nconst y = 2")]);
    expect(result.segments.filter((segment) => segment.kind === "code-block")).toHaveLength(1);
    expect(result.segments.filter((segment) => segment.kind === "source-code-fact")).toHaveLength(2);
  });
  it("creates no segments for blank-only content", () => {
    expect(segmentContextSources([source("blank.md", " \n\t\n")])).toEqual({ segments: [], skipped: [] });
  });
  it("handles valid, nested, invalid JSON and YAML", () => {
    expect(segmentContextSources([source("package.json", '{"scripts":{"test":"x"},"name":"c"}')]).segments).toHaveLength(2);
    const json = segmentContextSources([source("nested.json", '{\n  "object": { "text": "}" , "array": [1, {"x": "{"}] },\n  "plain": "value"\n}')]).segments;
    expect(json.map((segment) => [segment.startLine, segment.endLine, segment.rawExcerpt])).toEqual([[2, 2, '  "object": { "text": "}" , "array": [1, {"x": "{"}] },'], [3, 3, '  "plain": "value"']]);
    expect(segmentContextSources([source("bad.json", "{")]).skipped[0].reason).toBe("Invalid JSON configuration.");
    const yaml = segmentContextSources([source("a.yml", "---\n# comment\ntop:\n  child: yes\n\nother: no\n...\n")]).segments;
    expect(yaml.map((segment) => [segment.startLine, segment.endLine, segment.rawExcerpt])).toEqual([[3, 5, "top:\n  child: yes\n"], [6, 6, "other: no"]]);
  });

  it("accepts tab-indented list continuation and stops at boundaries", () => {
    const result = segmentContextSources([source("list.md", "- item\n\tcontinued\n\n- next\n\tmore\n# heading")]);
    expect(result.segments.map(({ kind, startLine, endLine, rawExcerpt }) => ({ kind, startLine, endLine, rawExcerpt }))).toEqual([
      { kind: "list-item", startLine: 1, endLine: 2, rawExcerpt: "- item\n\tcontinued" },
      { kind: "list-item", startLine: 4, endLine: 5, rawExcerpt: "- next\n\tmore" },
      { kind: "heading", startLine: 6, endLine: 6, rawExcerpt: "# heading" }
    ]);
  });
  it("is deterministic, order independent, and does not mutate input or use absolute paths", () => {
    const inputs = [source("b.ts", "b"), source("a.ts", "a")]; const before = JSON.stringify(inputs);
    const first = segmentContextSources(inputs); const second = segmentContextSources([...inputs].reverse());
    expect(second).toEqual(first); expect(JSON.stringify(inputs)).toBe(before);
    expect(segmentContextSources([source("a.ts", "a", "/other/path")]).segments[0].id).toBe(first.segments.find((segment) => segment.rawExcerpt === "a")?.id);
  });
  it("repeats stable segment IDs for identical input", () => {
    const input = [source("repeat.ts", "const value = 1")];
    const first = segmentContextSources(input);
    const second = segmentContextSources(input);
    expect(second.segments.map((segment) => segment.id)).toEqual(first.segments.map((segment) => segment.id));
  });
});
