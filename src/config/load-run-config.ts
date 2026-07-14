import { lstat, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { RunConfigError } from "../core/errors.js";
import type { LoadedRunConfig } from "../core/types.js";

const DEFAULT_TIMEOUT = 1800;

export async function loadRunConfig(repositoryPath: string): Promise<LoadedRunConfig> {
  if (repositoryPath.trim() === "") throw new RunConfigError("Repository path is empty.");
  let repositoryStat;
  try { repositoryStat = await stat(repositoryPath); } catch (cause) { throw new RunConfigError(`Repository path does not exist: ${repositoryPath}`, cause); }
  if (!repositoryStat.isDirectory()) throw new RunConfigError(`Repository path is not a directory: ${repositoryPath}`);
  const configPath = join(repositoryPath, "camarade.run.yaml");
  let text: string;
  try { const configStat = await lstat(configPath); if (!configStat.isFile()) throw new RunConfigError("Config path is not a regular file: camarade.run.yaml"); text = await readFile(configPath, "utf8"); }
  catch (cause) { if (cause instanceof RunConfigError) throw cause; if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { configPath: null, validationCommands: [], timeoutSeconds: DEFAULT_TIMEOUT }; throw new RunConfigError("Config cannot be read: camarade.run.yaml", cause); }
  let parsed: unknown;
  try { parsed = parse(text); } catch (cause) { throw new RunConfigError("Invalid YAML syntax in camarade.run.yaml.", cause); }
  if (parsed === null) parsed = {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new RunConfigError("YAML root must be a mapping in camarade.run.yaml.");
  const config = parsed as Record<string, unknown>;
  const rawCommands = config.validationCommands;
  if (rawCommands !== undefined && !Array.isArray(rawCommands)) throw new RunConfigError("validationCommands must be an array in camarade.run.yaml.");
  const commands = (rawCommands ?? []).map((command, index) => { if (typeof command !== "string" || command.trim() === "") throw new RunConfigError(`Validation command at index ${index} must be a non-empty string in camarade.run.yaml.`); return command.trim(); });
  if (new Set(commands).size !== commands.length) throw new RunConfigError("validationCommands contains duplicate commands after trimming in camarade.run.yaml.");
  const timeout = config.timeoutSeconds ?? DEFAULT_TIMEOUT;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0) throw new RunConfigError("timeoutSeconds must be a positive integer in camarade.run.yaml.");
  return { configPath, validationCommands: commands, timeoutSeconds: timeout };
}
