import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandAdapter } from "../src/adapters/command-adapter.js";
import {
  CodexExecutionAdapter,
  type CodexAdapterInput,
} from "../src/adapters/codex-adapter.js";
import type { AgentRunInput } from "../src/adapters/agent-adapter.js";
import {
  ExecutionAdapterInterruptedError,
  type NormalizedExecutionResult,
} from "../src/adapters/execution-adapter.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "camarade-adapter-conformance-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function expectLifecycle<TInput, TResult extends NormalizedExecutionResult>(
  adapter: {
    prepare(input: TInput): Promise<unknown>;
    executePrepared(prepared: never): Promise<unknown>;
    capture(prepared: never, execution: never): Promise<unknown>;
    cancel(prepared: never, execution: never, reason: never): void | Promise<void>;
    cleanup(prepared: never, execution: never): void | Promise<void>;
    normalize(captured: never): TResult | Promise<TResult>;
    execute(input: TInput): Promise<TResult>;
  },
  input: TInput,
): Promise<TResult> {
  const prepare = vi.spyOn(adapter, "prepare");
  const executePrepared = vi.spyOn(adapter, "executePrepared");
  const capture = vi.spyOn(adapter, "capture");
  const cleanup = vi.spyOn(adapter, "cleanup");
  const normalize = vi.spyOn(adapter, "normalize");
  const result = await adapter.execute(input);
  expect(result.exitCode).toBe(0);
  expect(result).toMatchObject({
    adapterId: expect.any(String),
    executable: expect.any(String),
    arguments: expect.any(Array),
    workingDirectory: expect.any(String),
    startedAt: expect.stringMatching(/T/u),
    completedAt: expect.stringMatching(/T/u),
    durationMs: expect.any(Number),
    timedOut: false,
    terminationReason: "exit",
    stdoutPath: expect.any(String),
    stderrPath: expect.any(String),
  });
  for (const hook of [prepare, executePrepared, capture, cleanup, normalize]) expect(hook).toHaveBeenCalledOnce();
  expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(executePrepared.mock.invocationCallOrder[0]!);
  expect(executePrepared.mock.invocationCallOrder[0]).toBeLessThan(capture.mock.invocationCallOrder[0]!);
  expect(capture.mock.invocationCallOrder[0]).toBeLessThan(normalize.mock.invocationCallOrder[0]!);
  expect(normalize.mock.invocationCallOrder[0]).toBeLessThan(cleanup.mock.invocationCallOrder[0]!);
  return result;
}

describe("provider-neutral execution adapter lifecycle", () => {
  it("runs the independent deterministic command adapter through the shared lifecycle", async () => {
    const directory = await temporaryDirectory();
    const script = join(directory, "deterministic.mjs");
    await writeFile(script, 'process.stdout.write("deterministic command\\n");\n');
    const input: AgentRunInput = {
      worktreePath: directory,
      task: "deterministic task",
      condition: "baseline",
      stdoutPath: join(directory, "command.stdout.log"),
      stderrPath: join(directory, "command.stderr.log"),
      timeoutMs: 2_000,
    };
    const signalTarget = new EventEmitter();
    const result = await expectLifecycle(new CommandAdapter(
      { executable: process.execPath, args: [script] },
      { signalTarget },
    ), input);
    expect(result).toMatchObject({
      adapterId: "command",
      executable: process.execPath,
      arguments: [script],
      workingDirectory: directory,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
    });
    expect(signalTarget.listenerCount("SIGINT")).toBe(0);
    expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
    expect(await readFile(result.stdoutPath, "utf8")).toBe("deterministic command\n");
  });

  it("runs the Codex Stage 5 implementation through the same lifecycle contract", async () => {
    const directory = await temporaryDirectory();
    const script = join(directory, "fake-codex.mjs");
    await writeFile(script, 'process.stdout.write("{\\\"type\\\":\\\"turn.completed\\\"}\\n");\n');
    const input: CodexAdapterInput = {
      conditionId: "camarade",
      worktreePath: directory,
      prompt: "deterministic prompt",
      runtime: {
        conditionId: "camarade",
        conditionDirectory: directory,
        logsDirectory: directory,
        promptPath: join(directory, "prompt.md"),
        invocationPath: join(directory, "invocation.json"),
        stdoutPath: join(directory, "codex.stdout.jsonl"),
        stderrPath: join(directory, "codex.stderr.log"),
        finalMessagePath: join(directory, "final.txt"),
        transcriptSummaryPath: join(directory, "transcript.json"),
        processResultPath: join(directory, "process.json"),
        gitStatusPath: join(directory, "git-status.txt"),
        changedFilesPath: join(directory, "changed-files.json"),
        patchPath: join(directory, "diff.patch"),
      },
      codex: {
        configuredExecutable: process.execPath,
        resolvedExecutable: process.execPath,
        executableVersion: process.version,
        configuredArguments: [script],
        fixedArguments: [],
        model: "deterministic",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        timeoutSeconds: 2,
        environmentAllowlist: [],
        environmentEvidence: [],
        configurationHash: "configuration",
      },
      environment: { PATH: process.env.PATH },
    };
    const signalTarget = new EventEmitter();
    const result = await expectLifecycle(new CodexExecutionAdapter({ signalTarget }), input);
    expect(result).toMatchObject({
      adapterId: "codex",
      executable: process.execPath,
      arguments: [
        script,
        "--cd",
        directory,
        "--color",
        "never",
        "--json",
        "--output-last-message",
        input.runtime.finalMessagePath,
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "-",
      ],
      workingDirectory: directory,
      stdoutPath: input.runtime.stdoutPath,
      stderrPath: input.runtime.stderrPath,
    });
    expect(signalTarget.listenerCount("SIGINT")).toBe(0);
    expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
    expect(await readFile(input.runtime.stdoutPath, "utf8")).toContain("turn.completed");
    expect(result.timedOut).toBe(false);
  });

  it("bounds Codex timeout cancellation from SIGTERM to forced process-tree termination", async () => {
    const directory = await temporaryDirectory();
    const script = join(directory, "ignore-term.mjs");
    await writeFile(script, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n');
    const runtime: CodexAdapterInput["runtime"] = {
      conditionId: "baseline",
      conditionDirectory: directory,
      logsDirectory: directory,
      promptPath: join(directory, "prompt.md"),
      invocationPath: join(directory, "invocation.json"),
      stdoutPath: join(directory, "timeout.stdout.jsonl"),
      stderrPath: join(directory, "timeout.stderr.log"),
      finalMessagePath: join(directory, "final.txt"),
      transcriptSummaryPath: join(directory, "transcript.json"),
      processResultPath: join(directory, "process.json"),
      gitStatusPath: join(directory, "git-status.txt"),
      changedFilesPath: join(directory, "changed-files.json"),
      patchPath: join(directory, "diff.patch"),
    };
    const started = Date.now();
    const result = await new CodexExecutionAdapter().execute({
      conditionId: "baseline",
      worktreePath: directory,
      prompt: "timeout prompt",
      runtime,
      codex: {
        configuredExecutable: process.execPath,
        resolvedExecutable: process.execPath,
        executableVersion: process.version,
        configuredArguments: [script],
        fixedArguments: [],
        model: "deterministic",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        timeoutSeconds: 0.1,
        environmentAllowlist: [],
        environmentEvidence: [],
        configurationHash: "configuration",
      },
      environment: { PATH: process.env.PATH },
    });
    expect(result).toMatchObject({
      exitCode: null,
      timedOut: true,
      terminationReason: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "cleans a resistant descendant and every listener after parent %s",
    async (signal) => {
      if (process.platform === "win32") return;
      const directory = await temporaryDirectory();
      const descendant = join(directory, "resistant-descendant.mjs");
      const controller = join(directory, "controller.mjs");
      const pidEvidence = join(directory, "processes.json");
      await writeFile(descendant, [
        'process.on("SIGINT", () => {});',
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"));
      await writeFile(controller, [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        `const descendant = spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(pidEvidence)}, JSON.stringify({ controller: process.pid, descendant: descendant.pid }));`,
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"));
      const signalTarget = new EventEmitter();
      const execution = new CommandAdapter(
        { executable: process.execPath, args: [controller] },
        { signalTarget },
      ).execute({
        worktreePath: directory,
        task: "Verify parent signal cleanup",
        condition: "baseline",
        stdoutPath: join(directory, `${signal}.stdout.log`),
        stderrPath: join(directory, `${signal}.stderr.log`),
        timeoutMs: 5_000,
      });

      let pids: { controller: number; descendant: number } | undefined;
      for (let attempt = 0; attempt < 100 && pids === undefined; attempt += 1) {
        pids = await readFile(pidEvidence, "utf8").then((value) => JSON.parse(value)).catch(() => undefined);
        if (pids === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(pids).toBeDefined();
      signalTarget.emit(signal);
      await expect(execution).rejects.toEqual(expect.objectContaining({
        name: "ExecutionAdapterInterruptedError",
        code: "EXECUTION_ADAPTER_INTERRUPTED",
        signal,
      } satisfies Partial<ExecutionAdapterInterruptedError>));
      expect(signalTarget.listenerCount("SIGINT")).toBe(0);
      expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
      for (const pid of [pids!.controller, pids!.descendant]) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    },
  );

  it("cancels and cleans up a failed lifecycle without invoking a fallback stage", async () => {
    const calls: string[] = [];
    const failure = new Error("execution failed");
    const signalTarget = new EventEmitter();
    const adapter = {
      id: "failure-fixture",
      signalTarget,
      async prepare() { calls.push("prepare"); return "prepared"; },
      async executePrepared() { calls.push("execute"); throw failure; },
      async capture() { calls.push("capture"); return {} as never; },
      async cancel() { calls.push("cancel"); },
      async cleanup() { calls.push("cleanup"); },
      normalize() { calls.push("normalize"); return {} as never; },
    };

    const { runExecutionAdapter } = await import("../src/adapters/execution-adapter.js");
    await expect(runExecutionAdapter(adapter, undefined)).rejects.toBe(failure);
    expect(calls).toEqual(["prepare", "execute", "cancel", "cleanup"]);
    expect(signalTarget.listenerCount("SIGINT")).toBe(0);
    expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
  });
});
