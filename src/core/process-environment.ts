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
  for (const key of PASSTHROUGH_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...additions };
}
