import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentRunResult } from "../core/types.js";
import { assertProcessTimeoutMilliseconds } from "../core/process-timeout.js";
import type { AgentAdapter, AgentRunInput } from "./agent-adapter.js";
import {
  runExecutionAdapter,
  type ExecutionAdapterLifecycle,
  type ExecutionCancellationReason,
} from "./execution-adapter.js";

export const SIMULATED_EXECUTION_LABEL = "SIMULATED EXECUTION — NOT BENCHMARK EVIDENCE";
export const FIXTURE_USAGE_UNAVAILABLE_REASON =
  "Fixture adapter does not produce token telemetry.";

const BASELINE_PUBLIC_SEARCH = `let requestCount = 0;

export async function publicSearch(request: Request): Promise<Response> {
  requestCount += 1;
  if (requestCount > 3) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "retry-after": "60" } }
    );
  }

  const query = new URL(request.url).searchParams.get("q") ?? "";
  return Response.json({ query, results: ["camarade"] });
}
`;

const CAMARADE_PUBLIC_SEARCH = `import { middleware } from "./middleware.ts";

export async function publicSearch(request: Request): Promise<Response> {
  return middleware(request, () => {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return Response.json({ query, results: ["camarade"] });
  });
}
`;

const BASELINE_AUTH = `export function requireUser(request: Request): Response | null {
  const authorization = request.headers.get("authorization");
  const simulatedBypass = request.headers.get("x-camarade-simulated-baseline");
  if (authorization === "Bearer fixture-user" || simulatedBypass === "allow") return null;
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function applyBaseline(worktreePath: string): Promise<void> {
  const packagePath = resolve(worktreePath, "package.json");
  const parsed: unknown = JSON.parse(await readFile(packagePath, "utf8"));
  if (!isRecord(parsed)) throw new TypeError("Fixture package.json must contain an object.");

  const dependencies = isRecord(parsed.dependencies) ? parsed.dependencies : {};
  parsed.dependencies = {
    ...dependencies,
    "express-rate-limit": "7.5.0"
  };

  await Promise.all([
    writeFile(packagePath, `${JSON.stringify(parsed, null, 2)}\n`),
    writeFile(resolve(worktreePath, "src/auth.ts"), BASELINE_AUTH),
    writeFile(resolve(worktreePath, "src/public-search.ts"), BASELINE_PUBLIC_SEARCH)
  ]);
}

async function applyCamarade(worktreePath: string): Promise<void> {
  await writeFile(resolve(worktreePath, "src/public-search.ts"), CAMARADE_PUBLIC_SEARCH);
}

async function writeSimulationLogs(
  input: AgentRunInput,
  stdoutPath: string,
  stderrPath: string
): Promise<void> {
  await Promise.all([
    mkdir(dirname(stdoutPath), { recursive: true }),
    mkdir(dirname(stderrPath), { recursive: true })
  ]);
  const stdout = await open(stdoutPath, "wx", 0o600);
  let stderr;
  try {
    stderr = await open(stderrPath, "wx", 0o600);
  } catch (cause) {
    await stdout.close();
    throw cause;
  }
  try {
    await Promise.all([
      stdout.writeFile(
        `${SIMULATED_EXECUTION_LABEL}\ncondition=${input.condition}\nfixture changes applied\n`,
        "utf8"
      ),
      stderr.writeFile(`${SIMULATED_EXECUTION_LABEL}\n`, "utf8")
    ]);
    await Promise.all([stdout.sync(), stderr.sync()]);
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }
}

export class FixtureAdapter implements AgentAdapter, ExecutionAdapterLifecycle<
  AgentRunInput,
  AgentRunInput,
  AgentRunResult,
  AgentRunResult,
  AgentRunResult
> {
  readonly id = "fixture";

  async prepare(input: AgentRunInput): Promise<AgentRunInput> {
    assertProcessTimeoutMilliseconds(input.timeoutMs, "Agent timeoutMs");
    return input;
  }

  async executePrepared(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    const worktreePath = resolve(input.worktreePath);
    const stdoutPath = resolve(input.stdoutPath);
    const stderrPath = resolve(input.stderrPath);

    if (input.condition === "baseline") await applyBaseline(worktreePath);
    else await applyCamarade(worktreePath);

    await writeSimulationLogs(input, stdoutPath, stderrPath);

    return {
      exitCode: 0,
      startedAt,
      completedAt: new Date().toISOString(),
      stdoutPath,
      stderrPath,
      usage: { unavailableReason: FIXTURE_USAGE_UNAVAILABLE_REASON }
    };
  }

  async capture(_prepared: AgentRunInput, execution: AgentRunResult): Promise<AgentRunResult> {
    return execution;
  }

  cancel(
    _prepared: AgentRunInput,
    _execution: AgentRunResult | undefined,
    _reason: ExecutionCancellationReason,
  ): void {}

  cleanup(): void {}

  normalize(captured: AgentRunResult): AgentRunResult {
    return captured;
  }

  async execute(input: AgentRunInput): Promise<AgentRunResult> {
    return runExecutionAdapter(this, input);
  }
}
