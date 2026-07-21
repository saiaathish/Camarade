import { spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  dependencies: {
    platform?: NodeJS.Platform;
    spawnTaskkill?: (pid: number, force: boolean) => SpawnSyncReturns<string>;
    killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
    killChild?: (signal: NodeJS.Signals) => boolean;
  } = {},
): Error | undefined {
  if (child.pid === undefined) return undefined;

  const platform = dependencies.platform ?? process.platform;
  const killChild = dependencies.killChild ?? ((requestedSignal) => child.kill(requestedSignal));
  const killProcessGroup = dependencies.killProcessGroup ??
    ((pid, requestedSignal) => process.kill(-pid, requestedSignal));
  const spawnTaskkill = dependencies.spawnTaskkill ?? ((pid, force) => spawnSync(
    "taskkill",
    ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])],
    { windowsHide: true, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
  ));

  try {
    if (platform === "win32") {
      const force = signal === "SIGKILL";
      const result = spawnTaskkill(child.pid, force);
      if (result.error !== undefined) {
        if (killChild(signal)) return undefined;
        return result.error;
      }
      if (result.status !== 0) {
        if (killChild(signal)) return undefined;
        const detail = String(result.stderr ?? "").trim();
        return new Error(
          `taskkill failed with exit code ${String(result.status)}${detail === "" ? "" : `: ${detail}`}`
        );
      }
    } else {
      killProcessGroup(child.pid, signal);
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    return asError(cause);
  }
  return undefined;
}
