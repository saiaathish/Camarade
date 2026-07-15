import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { discoverContext } from "../src/scanner/discover-context.js";
import { readDiscoveredContext } from "../src/scanner/read-context.js";
import { segmentContextSources } from "../src/intelligence/segment-sources.js";
import { parseInstructionSegments } from "../src/intelligence/parse-instructions.js";
import { inventoryRepository } from "../src/intelligence/inventory-repository.js";
import { detectRuleContradictions } from "../src/intelligence/detect-contradictions.js";
import { detectDuplicateRules } from "../src/intelligence/detect-duplicates.js";
import { mineRepositoryConventions } from "../src/intelligence/mine-conventions.js";
import { detectExceptions } from "../src/intelligence/detect-exceptions.js";
import { scoreFindingConfidence } from "../src/intelligence/score-confidence.js";
import { generateIntelligenceRecommendations } from "../src/intelligence/generate-recommendations.js";
import { createStableId } from "../src/intelligence/stable-id.js";

const fixture = resolve("examples/intelligence-fixture");

describe("S3-06 intelligence fixture proof", () => {
  it("runs bounded repository intelligence from real fixture files", async () => {
    const discovery = await discoverContext(fixture);
    const context = await readDiscoveredContext(discovery, { maxFileBytes: 100_000 });
    const segmented = segmentContextSources(context.sources);
    const intelligenceSources = context.sources.map(source => ({
      id: createStableId("source", [source.relativePath, source.sha256]),
      sourceType: source.kind === "configuration" ? "configuration" as const : "instruction" as const,
      relativePath: source.relativePath,
      sha256: source.sha256,
      authority: "high" as const
    }));
    const parsed = parseInstructionSegments(intelligenceSources, segmented.segments);
    const inventory = await inventoryRepository(fixture);
    const conventions = mineRepositoryConventions({ inventory, rules: parsed.rules, evidence: intelligenceSources });
    const contradictions = detectRuleContradictions(parsed.rules);
    const duplicates = detectDuplicateRules(parsed.rules);
    const exceptions = detectExceptions({
      rules: parsed.rules,
      inventory,
      conventions: conventions.conventions,
      outliers: []
    });
    const findings = [...contradictions.findings, ...duplicates.findings, ...conventions.findings, ...exceptions.findings]
      .sort((a, b) => a.id.localeCompare(b.id));
    const confidence = scoreFindingConfidence({
      findings,
      rules: parsed.rules,
      evidence: parsed.evidence,
      sources: intelligenceSources,
      references: [],
      architectureDecisions: conventions.architectureDecisions,
      history: { events: [], findings: [], records: [], availability: "unavailable", metadata: { commitCount: 0, ageCutoff: "HEAD-relative", shallow: false, truncated: false } },
      exceptions: exceptions.exceptions
    });
    const recommendations = generateIntelligenceRecommendations({ findings, confidenceAssessments: confidence });

    expect(discovery.files.map(file => file.relativePath)).toEqual([
      ".cursor/rules/api.md", ".github/copilot-instructions.md", "AGENTS.md", "CLAUDE.md", "camarade.run.yaml", "package.json"
    ]);
    expect(inventory.files.some(file => file.relativePath === "src/public-search.ts")).toBe(true);
    expect(parsed.rules.length).toBeGreaterThanOrEqual(5);
    expect(contradictions.findings.some(f => f.kind === "contradiction" || f.kind === "possible-conflict")).toBe(true);
    expect(conventions).toHaveProperty("conventions");
    expect(confidence).toHaveLength(findings.length);
    expect(recommendations).toHaveLength(findings.length);
    expect(JSON.stringify({ parsed, inventory, findings, confidence, recommendations })).not.toContain("/tmp/");
  });
});
