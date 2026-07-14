import { spawnSync, type ChildProcess } from "node:child_process";

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals
): Error | undefined {
  if (child.pid === undefined) return undefined;

  try {
    if (process.platform === "win32" && signal === "SIGKILL") {
      const result = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"]
      });
      if (result.error !== undefined) return result.error;
      if (result.status !== 0) {
        const detail = result.stderr.trim();
        return new Error(
          `taskkill failed with exit code ${String(result.status)}${detail === "" ? "" : `: ${detail}`}`
        );
      }
    } else if (process.platform === "win32") {
      if (!child.kill(signal)) return new Error(`Could not send ${signal} to process ${String(child.pid)}.`);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    return asError(cause);
  }
  return undefined;
}
