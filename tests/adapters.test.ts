import { spawnSync } from "node:child_process";
import { access, cp, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommandAdapter,
  COMMAND_USAGE_UNAVAILABLE_REASON
} from "../src/adapters/command-adapter.js";
import {
  FixtureAdapter,
  FIXTURE_USAGE_UNAVAILABLE_REASON,
  SIMULATED_EXECUTION_LABEL
} from "../src/adapters/fixture-adapter.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

async function heroFixture(): Promise<string> {
  const path = await temporaryDirectory("camarade-adapter-fixture-");
  await cp(resolve("examples/hero-fixture-template"), path, { recursive: true });
  return path;
}

function fixtureValidation(worktreePath: string): number | null {
  return spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["test"],
    { cwd: worktreePath, encoding: "utf8" }
  ).status;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("FixtureAdapter", () => {
  it("creates a deterministic, labeled baseline with known instruction and validation failures", async () => {
    const worktreePath = await heroFixture();
    const authPath = join(worktreePath, "src/auth.ts");
    const originalAuth = await readFile(authPath, "utf8");
    const stdoutPath = join(worktreePath, ".camarade/logs/baseline.stdout.log");
    const stderrPath = join(worktreePath, ".camarade/logs/baseline.stderr.log");

    const result = await new FixtureAdapter().execute({
      worktreePath,
      task: "Add rate limiting to the public search API",
      condition: "baseline",
      stdoutPath,
      stderrPath,
      timeoutMs: 1_000
    });

    const packageJson: unknown = JSON.parse(await readFile(join(worktreePath, "package.json"), "utf8"));
    expect(packageJson).toMatchObject({ dependencies: { "express-rate-limit": "7.5.0" } });
    expect(await readFile(authPath, "utf8")).not.toBe(originalAuth);
    expect(await readFile(join(worktreePath, "src/public-search.ts"), "utf8")).toContain(
      "requestCount > 3"
    );
    expect(fixtureValidation(worktreePath)).not.toBe(0);
    expect(await readFile(stdoutPath, "utf8")).toBe(
      `${SIMULATED_EXECUTION_LABEL}\ncondition=baseline\nfixture changes applied\n`
    );
    expect(await readFile(stderrPath, "utf8")).toBe(`${SIMULATED_EXECUTION_LABEL}\n`);
    expect(result).toMatchObject({
      exitCode: 0,
      stdoutPath,
      stderrPath,
      usage: { unavailableReason: FIXTURE_USAGE_UNAVAILABLE_REASON }
    });
    expect(Date.parse(result.startedAt)).not.toBeNaN();
    expect(Date.parse(result.completedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
  });

  it("reuses existing middleware for a passing Camarade implementation without protected changes", async () => {
    const worktreePath = await heroFixture();
    const authPath = join(worktreePath, "src/auth.ts");
    const billingPath = join(worktreePath, "src/billing.ts");
    const packagePath = join(worktreePath, "package.json");
    const before = await Promise.all(
      [authPath, billingPath, packagePath].map((path) => readFile(path, "utf8"))
    );
    const stdoutPath = join(worktreePath, ".camarade/logs/camarade.stdout.log");
    const stderrPath = join(worktreePath, ".camarade/logs/camarade.stderr.log");

    const result = await new FixtureAdapter().execute({
      worktreePath,
      task: "Add rate limiting to the public search API",
      condition: "camarade",
      contextPackPath: join(worktreePath, ".camarade/context.md"),
      stdoutPath,
      stderrPath,
      timeoutMs: 1_000
    });

    expect(
      await Promise.all([authPath, billingPath, packagePath].map((path) => readFile(path, "utf8")))
    ).toEqual(before);
    expect(await readFile(join(worktreePath, "src/public-search.ts"), "utf8")).toContain(
      'import { middleware } from "./middleware.ts";'
    );
    expect(fixtureValidation(worktreePath)).toBe(0);
    expect(await readFile(stdoutPath, "utf8")).toContain(SIMULATED_EXECUTION_LABEL);
    expect(await readFile(stderrPath, "utf8")).toBe(`${SIMULATED_EXECUTION_LABEL}\n`);
    expect(result.usage).toEqual({ unavailableReason: FIXTURE_USAGE_UNAVAILABLE_REASON });
  });

  it("refuses to overwrite existing fixture execution logs", async () => {
    const worktreePath = await heroFixture();
    const stdoutPath = join(worktreePath, "preserved.stdout.log");
    const stderrPath = join(worktreePath, "preserved.stderr.log");
    await writeFile(stdoutPath, "preserved\n");

    await expect(new FixtureAdapter().execute({
      worktreePath,
      task: "Add rate limiting to the public search API",
      condition: "camarade",
      stdoutPath,
      stderrPath,
      timeoutMs: 1_000
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(stdoutPath, "utf8")).toBe("preserved\n");
    await expect(access(stderrPath)).rejects.toThrow();
  });
});

describe("CommandAdapter", () => {
  it("rejects timeouts larger than the Node timer limit", async () => {
    const worktreePath = await temporaryDirectory("camarade-command-timeout-limit-");
    await expect(new CommandAdapter({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"]
    }).execute({
      worktreePath,
      task: "Reject unsafe timeout",
      condition: "baseline",
      stdoutPath: join(worktreePath, "stdout.log"),
      stderrPath: join(worktreePath, "stderr.log"),
      timeoutMs: 2_147_483_648
    })).rejects.toThrow("at most 2147483647 milliseconds");
  });

  it("runs without a shell in the worktree with scoped Camarade environment and captured output", async () => {
    const worktreePath = await temporaryDirectory("camarade-command-adapter-");
    const scriptPath = join(worktreePath, "inspect-environment.mjs");
    const contextPackPath = join(worktreePath, "compiled context.md");
    await writeFile(scriptPath, `const evidence = {
  cwd: process.cwd(),
  task: process.env.CAMARADE_TASK,
  condition: process.env.CAMARADE_CONDITION,
  contextPath: process.env.CAMARADE_CONTEXT_PATH,
  path: process.env.PATH,
  inheritedSecret: process.env.CAMARADE_TEST_SECRET,
  arguments: process.argv.slice(2)
};
process.stdout.write(JSON.stringify(evidence));
process.stderr.write("captured stderr\\n");
`);

    const stdoutPath = join(worktreePath, "artifacts/logs/command.stdout.log");
    const stderrPath = join(worktreePath, "artifacts/logs/command.stderr.log");
    const adapter = new CommandAdapter({
      executable: process.execPath,
      args: [scriptPath, "$HOME", "value;exit 9"]
    });
    process.env.CAMARADE_TEST_SECRET = "must-not-be-forwarded";
    const result = await adapter.execute({
      worktreePath,
      task: "Inspect only the adapter environment",
      condition: "camarade",
      contextPackPath,
      stdoutPath,
      stderrPath,
      timeoutMs: 2_000
    });
    delete process.env.CAMARADE_TEST_SECRET;

    const evidence: unknown = JSON.parse(await readFile(stdoutPath, "utf8"));
    expect(adapter.id).toBe("command");
    expect(evidence).toEqual({
      cwd: await realpath(worktreePath),
      task: "Inspect only the adapter environment",
      condition: "camarade",
      contextPath: contextPackPath,
      path: process.env.PATH,
      arguments: ["$HOME", "value;exit 9"]
    });
    expect(await readFile(stderrPath, "utf8")).toBe("captured stderr\n");
    if (process.platform !== "win32") {
      expect((await stat(stdoutPath)).mode & 0o777).toBe(0o600);
      expect((await stat(stderrPath)).mode & 0o777).toBe(0o600);
    }
    expect(result).toMatchObject({
      exitCode: 0,
      stdoutPath,
      stderrPath,
      usage: { unavailableReason: COMMAND_USAGE_UNAVAILABLE_REASON }
    });
    expect(Date.parse(result.startedAt)).not.toBeNaN();
    expect(Date.parse(result.completedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
  });

  it("terminates a timed-out command and reports a null exit code", async () => {
    const worktreePath = await temporaryDirectory("camarade-command-timeout-");
    const childScriptPath = join(worktreePath, "timeout-child.mjs");
    await writeFile(
      childScriptPath,
      `process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1_000);\n`
    );
    const scriptPath = join(worktreePath, "ignore-term.mjs");
    await writeFile(
      scriptPath,
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, [${JSON.stringify(childScriptPath)}], { stdio: "ignore" });
writeFileSync("timeout-child.pid", String(child.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`
    );
    const stdoutPath = join(worktreePath, "timeout.stdout.log");
    const stderrPath = join(worktreePath, "timeout.stderr.log");

    const result = await new CommandAdapter({
      executable: process.execPath,
      args: [scriptPath]
    }).execute({
      worktreePath,
      task: "Exercise timeout handling",
      condition: "baseline",
      stdoutPath,
      stderrPath,
      timeoutMs: 1_000
    });

    expect(result.exitCode).toBeNull();
    expect(await readFile(stderrPath, "utf8")).toContain(
      "[camarade] command timed out after 1000 ms"
    );
    const descendantPid = Number(await readFile(join(worktreePath, "timeout-child.pid"), "utf8"));
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  it("records an unavailable executable as a process error without inventing an exit code", async () => {
    const worktreePath = await temporaryDirectory("camarade-command-error-");
    const stdoutPath = join(worktreePath, "error.stdout.log");
    const stderrPath = join(worktreePath, "error.stderr.log");

    const result = await new CommandAdapter({
      executable: join(worktreePath, "missing-command"),
      args: []
    }).execute({
      worktreePath,
      task: "Exercise process error handling",
      condition: "baseline",
      stdoutPath,
      stderrPath,
      timeoutMs: 1_000
    });

    expect(result.exitCode).toBeNull();
    expect(await readFile(stdoutPath, "utf8")).toBe("");
    expect(await readFile(stderrPath, "utf8")).toContain("[camarade] command process error:");
  });
});
