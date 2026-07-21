import path from "node:path";

export interface PortableSpawnCommand {
  executable: string;
  arguments: string[];
  windowsVerbatimArguments: boolean;
}

function quoteCmdArgument(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll("\"", "\"\"")}"`;
}

export function preparePortableSpawn(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): PortableSpawnCommand {
  if (platform !== "win32" || ![".cmd", ".bat"].includes(path.win32.extname(executable).toLowerCase())) {
    return { executable, arguments: [...arguments_], windowsVerbatimArguments: false };
  }

  const commandInterpreter = environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe";
  const commandLine = [executable, ...arguments_].map(quoteCmdArgument).join(" ");
  return {
    executable: commandInterpreter,
    arguments: ["/d", "/s", "/c", commandLine],
    windowsVerbatimArguments: false,
  };
}
