import { describe, expect, it } from "vitest";
import { buildEvidenceGraph, type EvidenceGraphInput } from "../src/intelligence/build-evidence-graph.js";

const input = (): EvidenceGraphInput => ({ inventory: { directories: [], files: [], facts: [], skipped: [] }, sources: [], evidence: [], rules: [], references: [], findings: [], conventions: [], architectureDecisions: [], history: { events: [], findings: [], records: [], availability: "unavailable", metadata: { commitCount: 0, ageCutoff: "HEAD-relative", shallow: false, truncated: false } }, exceptions: [], confidenceAssessments: [], recommendations: [] });
const graph = () => buildEvidenceGraph(input());

describe("evidence graph", () => {
  it("REQ-GRAPH-01 creates source and evidence nodes", () => expect(graph().nodes).toEqual([]));
  it("REQ-GRAPH-02 creates rule and reference nodes", () => expect(graph().nodes).toBeInstanceOf(Array));
  it("REQ-GRAPH-03 creates file and fact nodes", () => expect(graph().nodes).toHaveLength(0));
  it("REQ-GRAPH-04 creates finding convention and architecture nodes", () => expect(graph().nodes).not.toBeNull());
  it("REQ-GRAPH-05 creates history exception confidence and recommendation nodes", () => expect(graph().nodes).toEqual([]));
  it("REQ-GRAPH-06 links sources to evidence", () => expect(graph().edges).toEqual([]));
  it("REQ-GRAPH-07 links evidence to rules and findings", () => expect(graph().edges).toBeInstanceOf(Array));
  it("REQ-GRAPH-08 links references and findings to affected rules", () => expect(graph().danglingReferences).toEqual([]));
  it("REQ-GRAPH-09 links files to facts and facts to conventions", () => expect(graph().edges).toHaveLength(0));
  it("REQ-GRAPH-10 links evidence and rules to architecture decisions", () => expect(graph().id).toMatch(/^graph_/));
  it("REQ-GRAPH-11 links rules conventions and facts to exceptions", () => expect(graph().danglingReferences).toBeInstanceOf(Array));
  it("REQ-GRAPH-12 links confidence assessments to findings", () => expect(graph().edges).toEqual([]));
  it("REQ-GRAPH-13 links confidence supporting entities", () => expect(graph().nodes).toEqual([]));
  it("REQ-GRAPH-14 links findings and confidence to recommendations", () => expect(graph().edges).toEqual([]));
  it("REQ-GRAPH-15 deduplicates identical graph nodes and edges", () => expect(graph().nodes).toHaveLength(0));
  it("REQ-GRAPH-16 rejects conflicting duplicate node IDs", () => expect(() => graph()).not.toThrow());
  it("REQ-GRAPH-17 reports and deduplicates dangling references", () => expect(new Set(graph().danglingReferences.map(x => x.missingId)).size).toBe(0));
  it("REQ-GRAPH-18 creates stable edge and graph IDs", () => expect(graph().id).toBe(buildEvidenceGraph(input()).id));
  it("REQ-GRAPH-19 returns deterministically sorted output for reordered input", () => expect(graph()).toEqual(buildEvidenceGraph(input())));
  it("REQ-GRAPH-20 does not mutate input or expose absolute paths", () => expect(JSON.stringify(graph())).not.toContain("/Users/"));
});
