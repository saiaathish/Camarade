const PASSTHROUGH_ENVIRONMENT_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "COMSPEC",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR"
] as const;

export function createChildEnvironment(
  additions: Readonly<Record<string, string>> = {}
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const pathValue = process.env.PATH ?? process.env.Path;
  for (const key of PASSTHROUGH_ENVIRONMENT_KEYS) {
    if (key === "PATH" || key === "Path") continue;
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (pathValue !== undefined) {
    environment[process.platform === "win32" ? "Path" : "PATH"] = pathValue;
  }
  return { ...environment, ...additions };
}
