import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PortableInvocation = { command: string; args: string[] };
export type PortableCommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type PortableCommandOptions = PortableInvocation & {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maximumOutputBytes?: number;
};

export function repositoryRoot(importMetaUrl: string): string {
  return resolve(dirname(fileURLToPath(importMetaUrl)), "..");
}

export function isMain(importMetaUrl: string): boolean {
  return process.argv[1] !== undefined && resolve(fileURLToPath(importMetaUrl)) === resolve(process.argv[1]);
}

export function npmInvocation(args: readonly string[]): PortableInvocation {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined || npmCli.trim() === "") {
    throw new Error("NPM_EXEC_PATH_UNAVAILABLE: invoke this command through an npm script.");
  }
  return { command: process.execPath, args: [npmCli, ...args] };
}

export function tsxInvocation(root: string, script: string, args: readonly string[] = []): PortableInvocation {
  return { command: process.execPath, args: [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(root, script), ...args] };
}

export async function installedCamaradeInvocation(installRoot: string, args: readonly string[]): Promise<PortableInvocation> {
  const entry = resolve(installRoot, "node_modules/camarade/dist/src/bin/camarade.js");
  await access(entry);
  return { command: process.execPath, args: [entry, ...args] };
}

export function terminatePortableProcess(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
  }
}

export async function runPortableCommand(options: PortableCommandOptions): Promise<PortableCommandResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maximumOutputBytes = options.maximumOutputBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes <= 0) {
    throw new RangeError("Portable command limits must be positive safe integers.");
  }
  const started = Date.now();
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: process.platform !== "win32",
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let failure: Error | undefined;
  const collect = (target: Buffer[], chunk: Buffer): void => {
    outputBytes += chunk.byteLength;
    if (outputBytes > maximumOutputBytes && failure === undefined) {
      failure = new Error(`COMMAND_OUTPUT_LIMIT_EXCEEDED:${maximumOutputBytes}`);
      terminatePortableProcess(child);
      return;
    }
    if (failure === undefined) target.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
  const timer = setTimeout(() => {
    failure = new Error(`COMMAND_TIMEOUT:${timeoutMs}`);
    terminatePortableProcess(child);
  }, timeoutMs);
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", (exitCode, signal) => resolveChild({ exitCode, signal }));
  }).finally(() => clearTimeout(timer));
  if (failure !== undefined) throw failure;
  return {
    ...result,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    durationMs: Date.now() - started,
  };
}

export async function requirePortableSuccess(options: PortableCommandOptions): Promise<PortableCommandResult> {
  const result = await runPortableCommand(options);
  if (result.exitCode !== 0) {
    throw new Error(`COMMAND_FAILED:${options.command}:${String(result.exitCode)}\n${result.stderr || result.stdout}`);
  }
  return result;
}
