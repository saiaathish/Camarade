import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { ExperimentExecutionError } from "./experiment-errors.js";
import { preparePortableSpawn } from "../core/portable-spawn.js";
import { terminateProcessTree } from "../core/terminate-process-tree.js";

function pathImplementation(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

export function executableCandidates(
  executable: string,
  environment: NodeJS.ProcessEnv,
  baseDirectory?: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const implementation = pathImplementation(platform);
  const pathLike = executable.includes("/") || executable.includes("\\");
  const configured = pathLike && !implementation.isAbsolute(executable) && baseDirectory
    ? implementation.resolve(baseDirectory, executable)
    : executable;
  const pathEntries = implementation.isAbsolute(configured)
    ? [""]
    : (environment.PATH ?? environment.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const extensions = platform === "win32" && implementation.extname(configured) === ""
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];

  const candidates: string[] = [];
  for (const directory of pathEntries) {
    const base = directory === "" ? configured : implementation.join(directory, configured);
    for (const extension of extensions) candidates.push(`${base}${extension}`);
  }
  return [...new Set(candidates)];
}

export async function resolveCodexExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv,
  baseDirectory?: string,
): Promise<string> {
  if (!executable || executable.includes("\0")) {
    throw new ExperimentExecutionError("Codex executable is invalid.", "EXPERIMENT_CODEX_UNAVAILABLE", "executable-resolution");
  }
  for (const candidate of executableCandidates(executable, environment, baseDirectory)) {
    try {
      const resolvedPath = await realpath(candidate);
      const info = await stat(resolvedPath);
      if (!info.isFile()) continue;
      if (process.platform !== "win32") await access(resolvedPath, constants.X_OK);
      return resolvedPath;
    } catch {}
  }
  throw new ExperimentExecutionError("Codex executable is unavailable.", "EXPERIMENT_CODEX_UNAVAILABLE", "executable-resolution");
}

export async function resolveCodexVersion(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const { spawn } = await import("node:child_process");
  const command = preparePortableSpawn(executable, [...args, "--version"], environment);
  return await new Promise((resolveVersion, reject) => {
    const child = spawn(command.executable, command.arguments, {
      env: environment,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    const settleReject = (error: ExperimentExecutionError): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const timer = setTimeout(() => {
      terminateProcessTree(child, "SIGTERM");
      setTimeout(() => terminateProcessTree(child, "SIGKILL"), 250).unref();
      settleReject(new ExperimentExecutionError("Codex version resolution timed out.", "EXPERIMENT_CODEX_VERSION_FAILED", "version-resolution"));
    }, 10_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      settleReject(new ExperimentExecutionError("Codex version resolution failed.", "EXPERIMENT_CODEX_VERSION_FAILED", "version-resolution", {}, undefined, error));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      const line = output.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
      if (code !== 0 || !line) {
        settleReject(new ExperimentExecutionError("Codex version output was unavailable.", "EXPERIMENT_CODEX_VERSION_FAILED", "version-resolution"));
      } else {
        settled = true;
        resolveVersion(line);
      }
    });
  });
}
