import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../src/context/context-serialization.js";
import { FixtureContextReasoner } from "../src/context/fixture-reasoner.js";
import type { ContextReasoner } from "../src/context/context-types.js";
import { compileRepositoryIntelligence } from "../src/intelligence/compile-repository-intelligence.js";
import { inventoryRepository } from "../src/intelligence/inventory-repository.js";
import { compileContextPipeline } from "../src/pipeline/compile-context-pipeline.js";

const heroRepository = resolve("examples/intelligence-fixture");
const task = "Add rate limiting to the public search API";
const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

async function controller(): Promise<string> {
  const root = await temporaryRoot("camarade-context-e2e-");
  const value = join(root, "controller");
  await mkdir(value);
  return realpath(value);
}

async function repositoryCopy(): Promise<string> {
  const root = await temporaryRoot("camarade-context-repo-");
  const repository = join(root, "repository");
  await cp(heroRepository, repository, { recursive: true });
  return repository;
}

async function decisions(path: string): Promise<Array<{ candidateId: string; decision: string; reasonCodes: string[] }>> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function candidates(path: string): Promise<Array<{ candidateId: string; statement: string; category: string; sourcePaths: string[] }>> {
  return JSON.parse(await readFile(path, "utf8"));
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("context compilation pipeline", () => {
  it("runs the hero twice with deterministic candidates, decisions, structure, evidence, and byte-identical Markdown", async () => {
    const first = await compileContextPipeline({ repositoryPath: heroRepository, task });
    const second = await compileContextPipeline({ repositoryPath: heroRepository, task });
    roots.push(first.controllerRoot, second.controllerRoot);
    expect(first.compilationId).not.toBe(second.compilationId);
    expect(await readFile(first.artifacts.taskSpecification, "utf8")).toBe(await readFile(second.artifacts.taskSpecification, "utf8"));
    expect(await readFile(first.artifacts.candidates, "utf8")).toBe(await readFile(second.artifacts.candidates, "utf8"));
    expect(await readFile(first.artifacts.decisions, "utf8")).toBe(await readFile(second.artifacts.decisions, "utf8"));
    expect(await readFile(first.artifacts.contractMarkdown, "utf8")).toBe(await readFile(second.artifacts.contractMarkdown, "utf8"));
    const normalize = (contract: typeof first.contract) => ({ ...contract, compilationId: "<compilation>" });
    expect(normalize(first.contract)).toEqual(normalize(second.contract));
    expect(first.contract.provenance.evidenceIds).toEqual(second.contract.provenance.evidenceIds);
    expect(first.manifest.reasoner).toEqual(second.manifest.reasoner);
  }, 20_000);

  it("proves the intended hero selections, exclusions, and one unresolved policy choice", async () => {
    const result = await compileContextPipeline({ repositoryPath: heroRepository, task });
    roots.push(result.controllerRoot);
    const selectedStatements = [
      ...result.contract.relevantArchitecture,
      ...result.contract.requirements,
      ...result.contract.constraints,
      ...result.contract.relevantFiles,
      ...result.contract.protectedFiles
    ].map((item) => item.statement);
    expect(selectedStatements).toContain("Use the shared middleware for API security");
    expect(selectedStatements).toEqual(expect.arrayContaining([
      "Relevant repository file: src/middleware.ts.",
      "Relevant repository file: src/public-search.ts.",
      "Relevant repository file: src/rate-limit.ts.",
      "Relevant repository file: tests/public-search.test.ts.",
      "Do not modify `src/auth.ts`"
    ]));
    expect(result.contract.validationCommands).toEqual(["npm test"]);
    expect(result.contract.protectedFiles.filter((item) => item.statement === "Do not modify `src/auth.ts`")).toHaveLength(1);
    expect(result.contract.unresolvedDecisions).toHaveLength(1);
    expect(result.contract.unresolvedDecisions[0].statement).toContain("fixed-window");
    expect(result.contract.unresolvedDecisions[0].statement).toContain("sliding-window");

    const allCandidates = await candidates(result.artifacts.candidates);
    const allDecisions = new Map((await decisions(result.artifacts.decisions)).map((item) => [item.candidateId, item]));
    const decisionsFor = (pattern: RegExp) => allCandidates
      .filter((item) => pattern.test(item.statement))
      .map((item) => allDecisions.get(item.candidateId));
    expect(decisionsFor(/per-handler rate limiting/iu)).not.toHaveLength(0);
    expect(decisionsFor(/per-handler rate limiting/iu).every((value) => value?.decision === "exclude")).toBe(true);
    expect(decisionsFor(/express-rate-limit/iu).every((value) => value?.decision === "exclude")).toBe(true);
    expect(decisionsFor(/pages\/api\/public/iu).every((value) => value?.decision === "exclude")).toBe(true);
    expect(selectedStatements.some((value) => /billing/iu.test(value))).toBe(false);
    expect(selectedStatements.some((value) => /Unauthorized|requireUser/iu.test(value))).toBe(false);
  }, 20_000);

  it("selects different context for different tasks without backend-to-frontend leakage", async () => {
    const billing = await compileContextPipeline({
      repositoryPath: heroRepository,
      task: "Document the billing portal implementation"
    });
    const frontend = await compileContextPipeline({
      repositoryPath: heroRepository,
      task: "Add a frontend design system component"
    });
    roots.push(billing.controllerRoot, frontend.controllerRoot);
    const billingText = await readFile(billing.artifacts.contractMarkdown, "utf8");
    const frontendText = await readFile(frontend.artifacts.contractMarkdown, "utf8");
    expect(billingText).toContain("billing");
    expect(frontendText).not.toContain("public-search.ts");
    expect(frontendText).not.toContain("rate-limit.ts");
    expect(frontendText).not.toContain("shared middleware");
    expect(frontendText).not.toBe(billingText);
  }, 20_000);

  it("lets an explicit task override a contradictory repository restriction without unrelated blocking conflicts", async () => {
    const result = await compileContextPipeline({
      repositoryPath: heroRepository,
      task: "Modify src/auth.ts to add audit logging"
    });
    roots.push(result.controllerRoot);
    expect(result.contract.requirements.map((item) => item.statement)).toContain("Modify src/auth.ts to add audit logging");
    expect(result.contract.protectedFiles.map((item) => item.statement)).not.toContain("Do not modify `src/auth.ts`");
    expect(result.contract.unresolvedDecisions.map((item) => item.statement).join("\n")).not.toMatch(/fixed-window|sliding-window/iu);
    const allCandidates = await candidates(result.artifacts.candidates);
    const allDecisions = new Map((await decisions(result.artifacts.decisions)).map((item) => [item.candidateId, item]));
    const authRestrictions = allCandidates.filter((item) => item.statement === "Do not modify `src/auth.ts`");
    expect(authRestrictions.length).toBeGreaterThan(0);
    expect(authRestrictions.every((item) => allDecisions.get(item.candidateId)?.decision === "exclude")).toBe(true);
  }, 20_000);

  it("leaves the analyzed repository inventory unchanged", async () => {
    const before = canonicalJson(await inventoryRepository(heroRepository));
    const result = await compileContextPipeline({ repositoryPath: heroRepository, task });
    roots.push(result.controllerRoot);
    expect(canonicalJson(await inventoryRepository(heroRepository))).toBe(before);
    expect(result.controllerRoot.startsWith(heroRepository)).toBe(false);
  }, 20_000);

  it("strictly loads a matching artifact and rejects missing, malformed, mismatched, or drifted artifacts", async () => {
    const repository = await repositoryCopy();
    const controllerRoot = await controller();
    const artifactDirectory = join(repository, ".camarade");
    await mkdir(artifactDirectory);
    const compiled = await compileRepositoryIntelligence({ repositoryPath: repository, task, includeGitHistory: false });
    await writeFile(join(artifactDirectory, "intelligence.json"), compiled.artifactJson);
    const loaded = await compileContextPipeline({
      repositoryPath: repository,
      task,
      controllerRoot,
      intelligenceArtifactPath: ".camarade/intelligence.json"
    });
    expect(loaded.intelligenceArtifact.id).toBe(compiled.artifact.id);

    await expect(compileContextPipeline({
      repositoryPath: repository,
      task,
      controllerRoot,
      compilationId: "missing-artifact",
      intelligenceArtifactPath: ".camarade/missing.json"
    })).rejects.toMatchObject({ code: "CONTEXT_INTELLIGENCE_MISSING", stage: "load-intelligence" });
    await writeFile(join(artifactDirectory, "malformed.json"), "{");
    await expect(compileContextPipeline({
      repositoryPath: repository,
      task,
      controllerRoot,
      compilationId: "malformed-artifact",
      intelligenceArtifactPath: ".camarade/malformed.json"
    })).rejects.toMatchObject({ code: "CONTEXT_INTELLIGENCE_INVALID" });
    await expect(compileContextPipeline({
      repositoryPath: repository,
      task: "Fix the billing portal implementation",
      controllerRoot,
      compilationId: "mismatched-artifact",
      intelligenceArtifactPath: ".camarade/intelligence.json"
    })).rejects.toMatchObject({ code: "CONTEXT_INTELLIGENCE_INVALID", details: expect.objectContaining({ requestedTask: expect.any(String) }) });

    const sourceMasquerade = structuredClone(compiled.artifact);
    const sourceRule = sourceMasquerade.rules.find((rule) => /shared middleware for API security/iu.test(rule.statement));
    if (sourceRule === undefined) throw new Error("hero middleware rule missing");
    sourceRule.evidenceIds = [sourceMasquerade.sourceIndex[0].id];
    await writeFile(join(artifactDirectory, "source-masquerade.json"), canonicalJson(sourceMasquerade));
    await expect(compileContextPipeline({
      repositoryPath: repository,
      task,
      controllerRoot,
      compilationId: "source-masquerade",
      intelligenceArtifactPath: ".camarade/source-masquerade.json"
    })).rejects.toMatchObject({ code: "CONTEXT_INTELLIGENCE_INVALID", stage: "load-intelligence" });

    const factMasquerade = structuredClone(compiled.artifact);
    const factRule = factMasquerade.rules.find((rule) => /shared middleware for API security/iu.test(rule.statement));
    const billingFact = compiled.inventory.facts.find((fact) => fact.relativePath === "src/billing.ts" && fact.kind === "file-exists");
    if (factRule === undefined || billingFact === undefined) throw new Error("hero provenance fixtures missing");
    factRule.evidenceIds = [billingFact.id];
    await writeFile(join(artifactDirectory, "fact-masquerade.json"), canonicalJson(factMasquerade));
    await expect(compileContextPipeline({
      repositoryPath: repository,
      task,
      controllerRoot,
      compilationId: "fact-masquerade",
      intelligenceArtifactPath: ".camarade/fact-masquerade.json"
    })).rejects.toMatchObject({ code: "CONTEXT_INTELLIGENCE_INVALID", stage: "load-intelligence" });

    await writeFile(join(repository, "src/public-search.ts"), "export const changed = true;\n");
    await expect(compileContextPipeline({
      repositoryPath: repository,
      task,
      controllerRoot,
      compilationId: "drifted-artifact",
      intelligenceArtifactPath: ".camarade/intelligence.json"
    })).rejects.toMatchObject({ code: "CONTEXT_INTELLIGENCE_INVALID", details: { reason: "repository-drift" } });
  }, 30_000);

  it("detects repository mutation, preserves failure evidence, and removes final contract outputs", async () => {
    const repository = await repositoryCopy();
    const controllerRoot = await controller();
    const fixture = new FixtureContextReasoner();
    const mutatingReasoner: ContextReasoner = {
      id: "fixture-mutating-test",
      version: "1.0.0",
      async evaluate(input) {
        const response = await fixture.evaluate(input);
        await writeFile(join(repository, "src", "unexpected-mutation.ts"), "export {};\n");
        return response;
      }
    };
    let evidencePath = "";
    try {
      await compileContextPipeline({ repositoryPath: repository, task, controllerRoot, reasoner: mutatingReasoner });
    } catch (error) {
      expect(error).toMatchObject({ code: "CONTEXT_REPOSITORY_MODIFIED", stage: "repository-integrity" });
      evidencePath = String((error as { evidencePath?: string }).evidencePath ?? "");
    }
    expect(evidencePath).not.toBe("");
    const files = await readdir(evidencePath);
    expect(files).toContain("task-spec.json");
    expect(files).toContain("candidate-context.json");
    expect(files).toContain("compilation-summary.json");
    expect(files).not.toContain("context-contract.json");
    expect(files).not.toContain("context-contract.md");
    expect(JSON.parse(await readFile(join(evidencePath, "compilation-summary.json"), "utf8"))).toMatchObject({
      status: "failed",
      errorCode: "CONTEXT_REPOSITORY_MODIFIED"
    });
  }, 20_000);

  it("detects mutations in generated directories ignored by Stage 3 inventory", async () => {
    const repository = await repositoryCopy();
    const controllerRoot = await controller();
    const fixture = new FixtureContextReasoner();
    const mutatingReasoner: ContextReasoner = {
      id: "fixture-dist-mutating-test",
      version: "1.0.0",
      async evaluate(input) {
        const response = await fixture.evaluate(input);
        await mkdir(join(repository, "dist"), { recursive: true });
        await writeFile(join(repository, "dist", "mutated.js"), "export {};\n");
        return response;
      }
    };
    await expect(compileContextPipeline({ repositoryPath: repository, task, controllerRoot, reasoner: mutatingReasoner }))
      .rejects.toMatchObject({ code: "CONTEXT_REPOSITORY_MODIFIED", stage: "repository-integrity" });
  }, 20_000);

  it("detects symbolic-link identity mutations without following the link", async () => {
    const repository = await repositoryCopy();
    const controllerRoot = await controller();
    const linkPath = join(repository, "context-link.ts");
    await symlink("src/public-search.ts", linkPath);
    const fixture = new FixtureContextReasoner();
    const mutatingReasoner: ContextReasoner = {
      id: "fixture-link-mutating-test",
      version: "1.0.0",
      async evaluate(input) {
        const response = await fixture.evaluate(input);
        await unlink(linkPath);
        await symlink("src/rate-limit.ts", linkPath);
        return response;
      }
    };
    await expect(compileContextPipeline({ repositoryPath: repository, task, controllerRoot, reasoner: mutatingReasoner }))
      .rejects.toMatchObject({ code: "CONTEXT_REPOSITORY_MODIFIED", stage: "repository-integrity" });
  }, 20_000);

  it("rejects compilation directory collisions without overwriting the first result", async () => {
    const controllerRoot = await controller();
    const compilationId = "fixed-compilation-id";
    const first = await compileContextPipeline({ repositoryPath: heroRepository, task, controllerRoot, compilationId });
    const original = await readFile(first.artifacts.contractJson, "utf8");
    await expect(compileContextPipeline({ repositoryPath: heroRepository, task, controllerRoot, compilationId }))
      .rejects.toMatchObject({ code: "CONTEXT_ARTIFACT_EXISTS", stage: "write-context-artifacts" });
    expect(await readFile(first.artifacts.contractJson, "utf8")).toBe(original);
  }, 20_000);

  it("requires explicit controller roots to exist, be real directories, and remain outside the repository", async () => {
    const repository = await repositoryCopy();
    const root = await temporaryRoot("camarade-controller-safety-");
    const insideRepository = join(repository, "controller");
    await mkdir(insideRepository);
    await expect(compileContextPipeline({ repositoryPath: repository, task, controllerRoot: insideRepository }))
      .rejects.toMatchObject({ code: "CONTEXT_REQUEST_INVALID", stage: "controller-resolution" });
    await expect(compileContextPipeline({ repositoryPath: repository, task, controllerRoot: join(root, "missing") }))
      .rejects.toMatchObject({ code: "CONTEXT_REQUEST_INVALID", stage: "controller-resolution" });
    const target = join(root, "target");
    const linked = join(root, "linked");
    await mkdir(target);
    await symlink(target, linked);
    await expect(compileContextPipeline({ repositoryPath: repository, task, controllerRoot: linked }))
      .rejects.toMatchObject({ code: "CONTEXT_REQUEST_INVALID", stage: "controller-resolution" });
    const canonicalRoot = await realpath(root);
    const realAncestor = join(canonicalRoot, "real-ancestor");
    const linkedAncestor = join(canonicalRoot, "linked-ancestor");
    await mkdir(join(realAncestor, "controller"), { recursive: true });
    await symlink(realAncestor, linkedAncestor);
    await expect(compileContextPipeline({
      repositoryPath: repository,
      task,
      controllerRoot: join(linkedAncestor, "controller")
    })).rejects.toMatchObject({ code: "CONTEXT_REQUEST_INVALID", stage: "controller-resolution" });
  });
});
