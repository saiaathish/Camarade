import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
export async function openDashboardUrl(url: string): Promise<void> {
  const platform = process.platform;
  const executable = platform === "darwin" ? "open" : platform === "win32" ? "rundll32" : "xdg-open";
  const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await run(executable, args);
}
