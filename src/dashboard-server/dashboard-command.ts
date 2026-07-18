import { openDashboardUrl } from "./browser-opener.js";
import { closeDashboardServer, startDashboardServer, type DashboardServer } from "./index.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const DEFAULT_DASHBOARD_PORT = 4317;
export function validateDashboardId(id: string | undefined): string | undefined { if (id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(id)) throw new Error("Unsafe comparison ID."); return id; }
export function validateDashboardPort(value: string | undefined): number { const p = value === undefined ? DEFAULT_DASHBOARD_PORT : Number(value); if (!Number.isSafeInteger(p) || p < 1 || p > 65535) throw new Error("--port must be an integer from 1 to 65535."); return p; }
export async function runDashboard(options: { comparisonId?: string; controllerRoot?: string; port?: number; noOpen?: boolean; frontendRoot?: string }, io: { stdout: (s:string)=>void; stderr:(s:string)=>void } = { stdout: console.log, stderr: console.error }): Promise<number> {
  const id = validateDashboardId(options.comparisonId); const frontendRoot = options.frontendRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../frontend"); const server = await startDashboardServer({ controllerRoot: options.controllerRoot, port: options.port ?? DEFAULT_DASHBOARD_PORT, frontendRoot }); const url = `${server.origin}${id ? `/runs/${encodeURIComponent(id)}/` : "/runs/"}`;
  io.stdout(`Dashboard running at ${url}\nPress Ctrl+C to stop.\n`);
  if (!options.noOpen) { try { await openDashboardUrl(url); } catch { io.stderr(`Warning: browser could not be opened; use ${url}\n`); } }
  const stop = async () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); await closeDashboardServer(server); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop); await server.closed; return 0;
}
