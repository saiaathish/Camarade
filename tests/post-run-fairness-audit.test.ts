import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runExecutionAdapter } from "../src/adapters/execution-adapter.js";
import { canonicalJson, sha256 } from "../src/context/context-serialization.js";
import { startDashboardServer } from "../src/dashboard-server/index.js";
import { SafeDashboardRunRepository } from "../src/evaluate/run-store.js";
import { auditExperimentFairness, type AuditExperimentFairnessInput } from "../src/experiment/audit-experiment-fairness.js";
import { runFairExperimentSchema } from "../src/mcp/tools/run-fair-experiment-schema.js";

function fixture(): AuditExperimentFairnessInput {
  const prompt = (conditionId: "baseline" | "camarade", contextHash: string, promptPath: string) => ({
    conditionId,
    taskHash: "task",
    contextHash,
    templateHash: "template",
    promptHash: `${conditionId}-prompt`,
    promptPath,
    byteLength: 10,
  });
  const invocation = (conditionId: "baseline" | "camarade") => ({
    conditionId,
    executable: "/bin/agent",
    executableVersion: "1.0.0",
    arguments: ["--model", "fixed"],
    normalizedArgumentsHash: "arguments",
    workingDirectory: `/${conditionId}`,
    timeoutSeconds: 60,
    prompt: prompt(conditionId, conditionId, `/${conditionId}/prompt.md`),
    environmentPolicyHash: "environment",
  });
  const context = (conditionId: "baseline" | "camarade") => ({
    conditionId,
    contextKind: conditionId === "baseline" ? "original-repository" as const : "camarade-compiled" as const,
    contextPath: `/controller/${conditionId}/context.md`,
    contextHash: conditionId,
    sourcePaths: [`${conditionId}-context.md`],
    instructionMode: "augmentation" as const,
    originalContextArchivePath: "/controller/private/archive",
    originalContextArchiveHash: "archive",
    optimizedOriginalContextAccess: false,
  });
  const worktree = (conditionId: "baseline" | "camarade") => ({
    conditionId,
    path: `/${conditionId}`,
    startingCommit: "commit",
    startingTree: "tree",
    trackedTreeHash: "tracked",
    clean: true as const,
  });
  const command = (conditionId: "baseline" | "camarade") => ({
    command: "npm test",
    exitCode: 0,
    durationMs: 1,
    stdoutPath: `/${conditionId}/stdout.log`,
    stderrPath: `/${conditionId}/stderr.log`,
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:00:01.000Z",
    timedOut: false,
    spawnFailed: false,
    terminationWarnings: [],
  });
  const startingState = {
    repositoryPath: "/repository",
    startingCommit: "commit",
    startingTree: "tree",
    repositoryFingerprint: "fingerprint",
    clean: true as const,
    submodules: [],
  };
  return {
    prepared: {
      status: "prepared",
      specification: {
        schemaVersion: "1.0.0",
        experimentId: "experiment",
        specificationId: "specification",
        specificationHash: "hash",
        controllerVersion: "1",
        repositoryPath: "/repository",
        task: { original: "task", normalized: "task", sha256: "task" },
        instructionMode: "augmentation",
        executionOrder: "baseline-first",
        orderedConditionIds: ["baseline", "camarade"],
        conditions: [
          { conditionId: "baseline", contextKind: "original-repository" },
          { conditionId: "camarade", contextKind: "camarade-compiled" },
        ],
        contextBudget: { unit: "characters", maximum: 10, maximumItems: 1, maximumEvidenceItemsPerRule: 1 },
        codex: { executable: "agent", arguments: ["--model", "fixed"], timeoutSeconds: 60, environmentAllowlist: [] },
        validationCommands: ["npm test"],
        hashes: { codexConfiguration: "codex", validationConfiguration: "validation", contextBudget: "budget" },
      },
      startingState,
      layout: {} as never,
      baseline: { conditionId: "baseline", worktree: worktree("baseline"), context: context("baseline"), taskHash: "task", codexConfigurationHash: "codex", validationConfigurationHash: "validation", contextBudgetHash: "budget" },
      camarade: { conditionId: "camarade", worktree: worktree("camarade"), context: context("camarade"), taskHash: "task", codexConfigurationHash: "codex", validationConfigurationHash: "validation", contextBudgetHash: "budget" },
      fairnessAudit: { status: "pass", checks: [{ checkId: "prepared", status: "pass", message: "pass" }] },
      artifacts: {} as never,
    },
    executed: {
      status: "complete",
      experimentId: "experiment",
      executionOrder: ["baseline", "camarade"],
      codex: {
        configuredExecutable: "agent",
        resolvedExecutable: "/bin/agent",
        executableVersion: "1.0.0",
        configuredArguments: ["--model", "fixed"],
        fixedArguments: [],
        model: "fixed",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        timeoutSeconds: 60,
        environmentAllowlist: [],
        environmentEvidence: [],
        configurationHash: "environment",
      },
      baseline: { conditionId: "baseline", prompt: prompt("baseline", "baseline", "/baseline/prompt.md"), invocation: invocation("baseline"), result: {} as never },
      camarade: { conditionId: "camarade", prompt: prompt("camarade", "camarade", "/camarade/prompt.md"), invocation: invocation("camarade"), result: {} as never },
      fairnessAudit: { status: "pass", checks: [{ checkId: "executed", status: "pass", message: "pass" }] },
      executionResultPath: "/controller/execution-result.json",
    },
    baselineValidation: { conditionId: "baseline", status: "passed", commands: [{ ...command("baseline"), sequence: 1 }], commandListHash: "commands", timeoutSeconds: 60, environment: { keys: [], policyHash: "policy", normalizedValueHash: "environment" }, resultPath: "/baseline/validation.json" },
    camaradeValidation: { conditionId: "camarade", status: "passed", commands: [{ ...command("camarade"), sequence: 1 }], commandListHash: "commands", timeoutSeconds: 60, environment: { keys: [], policyHash: "policy", normalizedValueHash: "environment" }, resultPath: "/camarade/validation.json" },
    sourcePostRunState: { ...startingState },
  };
}

function expectFailure(change: (value: AuditExperimentFairnessInput) => void, checkId: string): void {
  const value = fixture();
  change(value);
  const audit = auditExperimentFairness(value);
  expect(audit.status).toBe("fail");
  expect(audit.checks.find((entry) => entry.checkId === checkId)?.status).toBe("fail");
}

describe("S5-04 post-run fairness audit", () => {
  it("passes matched persisted evidence without scoring an outcome", () => {
    const audit = auditExperimentFairness(fixture());
    expect(audit.status).toBe("pass");
    expect(audit.checks.some((entry) => /score|winner|outcome/u.test(entry.checkId))).toBe(false);
  });

  it.each([
    ["preparation-audit-passed", (value: AuditExperimentFairnessInput) => { value.prepared.fairnessAudit.status = "fail"; }],
    ["execution-audit-passed", (value: AuditExperimentFairnessInput) => { value.executed.fairnessAudit.status = "fail"; }],
    ["execution-audit-passed", (value: AuditExperimentFairnessInput) => { value.executed.fairnessAudit.checks = []; }],
    ["same-starting-commit", (value: AuditExperimentFairnessInput) => { value.prepared.camarade.worktree.startingCommit = "changed"; }],
    ["same-starting-tree", (value: AuditExperimentFairnessInput) => { value.prepared.camarade.worktree.startingTree = "changed"; }],
    ["same-tracked-tree-hash", (value: AuditExperimentFairnessInput) => { value.prepared.camarade.worktree.trackedTreeHash = "changed"; }],
    ["same-task-hash", (value: AuditExperimentFairnessInput) => { value.prepared.camarade.taskHash = "changed"; }],
    ["same-context-budget", (value: AuditExperimentFairnessInput) => { value.prepared.camarade.contextBudgetHash = "changed"; }],
    ["expected-context-treatment-difference", (value: AuditExperimentFairnessInput) => { value.prepared.camarade.context.contextHash = value.prepared.baseline.context.contextHash; }],
    ["same-agent-executable", (value: AuditExperimentFairnessInput) => { value.executed.camarade.invocation.executable = "/bin/other"; }],
    ["same-agent-version", (value: AuditExperimentFairnessInput) => { value.executed.camarade.invocation.executableVersion = "2.0.0"; }],
    ["same-agent-arguments", (value: AuditExperimentFairnessInput) => { value.executed.camarade.invocation.arguments = ["--model", "other"]; }],
    ["same-agent-arguments", (value: AuditExperimentFairnessInput) => { value.executed.camarade.invocation.normalizedArgumentsHash = "changed"; }],
    ["same-agent-timeout", (value: AuditExperimentFairnessInput) => { value.executed.camarade.invocation.timeoutSeconds = 61; }],
    ["same-agent-environment-policy", (value: AuditExperimentFairnessInput) => { value.executed.camarade.invocation.environmentPolicyHash = "changed"; }],
    ["configured-model-recorded", (value: AuditExperimentFairnessInput) => { value.executed.codex.model = "   "; }],
    ["configured-sandbox-recorded", (value: AuditExperimentFairnessInput) => { value.executed.codex.sandbox = "read-only" as never; }],
    ["configured-approval-policy-recorded", (value: AuditExperimentFairnessInput) => { value.executed.codex.approvalPolicy = "on-request" as never; }],
    ["same-prompt-template", (value: AuditExperimentFairnessInput) => { value.executed.camarade.prompt.templateHash = "changed"; }],
    ["configured-execution-order-recorded", (value: AuditExperimentFairnessInput) => { value.executed.executionOrder = ["camarade", "baseline"]; }],
    ["same-validation-command-list", (value: AuditExperimentFairnessInput) => { value.camaradeValidation.commandListHash = "changed"; }],
    ["same-validation-command-order", (value: AuditExperimentFairnessInput) => { value.camaradeValidation.commands[0]!.command = "npm run other"; }],
    ["same-validation-command-count", (value: AuditExperimentFairnessInput) => { value.camaradeValidation.commands = []; }],
    ["same-validation-timeout", (value: AuditExperimentFairnessInput) => { value.camaradeValidation.timeoutSeconds = 61; }],
    ["same-validation-environment-values", (value: AuditExperimentFairnessInput) => { value.camaradeValidation.environment.normalizedValueHash = "changed"; }],
    ["separate-validation-log-paths", (value: AuditExperimentFairnessInput) => { value.camaradeValidation.commands[0]!.stdoutPath = value.baselineValidation.commands[0]!.stdoutPath; }],
    ["separate-validation-log-paths", (value: AuditExperimentFairnessInput) => { value.camaradeValidation.commands[0]!.stderrPath = value.baselineValidation.commands[0]!.stderrPath; }],
    ["separate-validation-log-paths", (value: AuditExperimentFairnessInput) => {
      const baseline = { ...value.baselineValidation.commands[0]!, command: "npm run second", sequence: 2, stdoutPath: "/baseline/second-stdout.log", stderrPath: "/baseline/second-stderr.log" };
      const camarade = { ...value.camaradeValidation.commands[0]!, command: "npm run second", sequence: 2, stdoutPath: baseline.stdoutPath, stderrPath: "/camarade/second-stderr.log" };
      value.baselineValidation.commands.push(baseline);
      value.camaradeValidation.commands.push(camarade);
    }],
    ["baseline-all-commands-attempted", (value: AuditExperimentFairnessInput) => { value.baselineValidation.commands = []; }],
    ["camarade-all-commands-attempted", (value: AuditExperimentFairnessInput) => { value.camaradeValidation.commands = []; }],
    ["separate-worktrees", (value: AuditExperimentFairnessInput) => { value.prepared.camarade.worktree.path = value.prepared.baseline.worktree.path; }],
    ["separate-context-paths", (value: AuditExperimentFairnessInput) => { value.prepared.camarade.context.contextPath = value.prepared.baseline.context.contextPath; }],
    ["separate-prompt-paths", (value: AuditExperimentFairnessInput) => { value.executed.camarade.prompt.promptPath = value.executed.baseline.prompt.promptPath; }],
    ["source-repository-path-unchanged", (value: AuditExperimentFairnessInput) => { value.sourcePostRunState.repositoryPath = "/changed"; }],
    ["source-commit-unchanged", (value: AuditExperimentFairnessInput) => { value.sourcePostRunState.startingCommit = "changed"; }],
    ["source-tree-unchanged", (value: AuditExperimentFairnessInput) => { value.sourcePostRunState.startingTree = "changed"; }],
    ["source-tracked-tree-hash-unchanged", (value: AuditExperimentFairnessInput) => { value.sourcePostRunState.repositoryFingerprint = "changed"; }],
    ["source-worktree-clean", (value: AuditExperimentFairnessInput) => { value.sourcePostRunState.clean = false; }],
  ])("fails %s when persisted evidence diverges", (checkId, change) => expectFailure(change, checkId));

  it("hashes the actual baseline and Camarade invocation evidence", () => {
    const value = fixture();
    const audit = auditExperimentFairness(value);
    const invocationChecks = [
      ["same-agent-executable", value.executed.baseline.invocation.executable, value.executed.camarade.invocation.executable],
      ["same-agent-version", value.executed.baseline.invocation.executableVersion, value.executed.camarade.invocation.executableVersion],
      ["same-agent-arguments", value.executed.baseline.invocation.arguments, value.executed.camarade.invocation.arguments],
      ["same-agent-timeout", value.executed.baseline.invocation.timeoutSeconds, value.executed.camarade.invocation.timeoutSeconds],
      ["same-agent-environment-policy", value.executed.baseline.invocation.environmentPolicyHash, value.executed.camarade.invocation.environmentPolicyHash],
    ] as const;

    for (const [checkId, baseline, camarade] of invocationChecks) {
      const check = audit.checks.find((entry) => entry.checkId === checkId);
      expect(check).toMatchObject({
        baselineValueHash: sha256(canonicalJson(baseline)),
        camaradeValueHash: sha256(canonicalJson(camarade)),
      });
    }
  });

  it("omits evidence hashes only for one-sided controller assertions", () => {
    const check = auditExperimentFairness(fixture()).checks.find((entry) => entry.checkId === "configured-model-recorded");
    expect(check).not.toHaveProperty("baselineValueHash");
    expect(check).not.toHaveProperty("camaradeValueHash");
  });

  it("treats absent validation command arrays as zero attempted commands", () => {
    const value = fixture();
    value.baselineValidation.commands = undefined as never;
    value.camaradeValidation.commands = undefined as never;
    const audit = auditExperimentFairness(value);
    expect(audit.checks.find((entry) => entry.checkId === "baseline-all-commands-attempted")?.status).toBe("fail");
    expect(audit.checks.find((entry) => entry.checkId === "camarade-all-commands-attempted")?.status).toBe("fail");
  });
});

describe("targeted release safety controls", () => {
  it("requires exact affirmative execution confirmation and a complete request", () => {
    const request = { repository_root: process.cwd(), task: "Run the bounded experiment", confirm_execution: true } as const;
    expect(runFairExperimentSchema.safeParse(request).success).toBe(true);
    expect(runFairExperimentSchema.safeParse({ ...request, confirm_execution: false }).success).toBe(false);
    expect(runFairExperimentSchema.safeParse({ repository_root: request.repository_root, task: request.task }).success).toBe(false);
  });

  it.each([
    ["x", true],
    ["ab", true],
    ["release-hardening_1.2", true],
    ["-prefixed", false],
    ["suffixed!", false],
    [`x${"a".repeat(64)}`, false],
  ])("enforces the complete experiment ID grammar for %s", (experimentId, accepted) => {
    expect(runFairExperimentSchema.safeParse({
      repository_root: process.cwd(),
      task: "Run the bounded experiment",
      confirm_execution: true,
      experiment_id: experimentId,
    }).success).toBe(accepted);
  });

  it("cancels, cleans up, and preserves adapter failures without fallback", async () => {
    const failure = new Error("adapter failed");
    const calls: string[] = [];
    const adapter = {
      id: "failing",
      async prepare() { calls.push("prepare"); return "prepared"; },
      async executePrepared() { calls.push("execute"); throw failure; },
      async capture() { calls.push("capture"); return "captured"; },
      async cancel(_prepared: string, _execution: never, reason: "error") { calls.push(`cancel:${reason}`); },
      async cleanup() { calls.push("cleanup"); },
      normalize() { calls.push("normalize"); return "normalized"; },
    };

    await expect(runExecutionAdapter(adapter, "input")).rejects.toBe(failure);
    expect(calls).toEqual(["prepare", "execute", "cancel:error", "cleanup"]);
  });

  it("accepts only exact loopback Host values and rejects reserved static paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "camarade-mutation-host-"));
    await mkdir(join(root, ".camarade", "runs"), { recursive: true });
    const dashboard = await startDashboardServer({ controllerRoot: root, port: 0, frontendRoot: join(root, "frontend") });
    const request = (path: string, host?: string) => new Promise<number>((resolve, reject) => {
      const options = {
        hostname: "127.0.0.1",
        port: dashboard.port,
        path,
        method: "GET",
        ...(host === undefined ? { setHost: false } : { headers: { host } }),
      };
      const outgoing = httpRequest(options, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      outgoing.once("error", reject);
      outgoing.end();
    });

    try {
      for (const host of ["localhost", "127.0.0.1", "::1"]) await expect(request("/api/health", host)).resolves.toBe(200);
      for (const host of ["evil.localhost", "localhost.evil"]) await expect(request("/api/health", host)).resolves.toBe(403);
      expect([400, 403]).toContain(await request("/api/health"));
      await expect(request("/~/private", "localhost")).resolves.toBe(400);
    } finally {
      await dashboard.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing, non-file, and symlink-ancestor dashboard evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "camarade-mutation-run-store-"));
    const runs = join(root, ".camarade", "runs");
    const valid = await readFile(join(process.cwd(), "fixtures", "stage-8", "dashboard", "valid-camarade-win.json"), "utf8");
    await mkdir(join(runs, "missing"), { recursive: true });
    await mkdir(join(runs, "directory", "dashboard-run.json"), { recursive: true });
    await mkdir(join(runs, "actual"), { recursive: true });
    await writeFile(join(runs, "actual", "dashboard-run.json"), valid);
    await symlink(join(runs, "actual"), join(runs, "linked"));
    const repository = new SafeDashboardRunRepository(root);

    try {
      for (const id of ["missing", "directory", "linked"]) {
        await expect(repository.getRun(id)).rejects.toMatchObject({ code: "UNKNOWN_COMPARISON_ID" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
