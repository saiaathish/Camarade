import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile, lstat, realpath } from "node:fs/promises";
import { resolve, relative, join, extname } from "node:path";
import { SafeDashboardRunRepository } from "../evaluate/run-store.js";

export type DashboardServerOptions = { controllerRoot?: string; port?: number; frontendRoot?: string };
export type DashboardServer = { host: string; port: number; origin: string; server: Server; closed: Promise<void>; close: () => Promise<void> };
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const HEALTH = { status: "ok", service: "camarade-local-dashboard", dashboardSchemaVersion: "stage-8-dashboard.v1" };
function headers(r: ServerResponse, contentType: string) { r.setHeader("Content-Type", contentType); r.setHeader("Cache-Control", "no-store"); r.setHeader("X-Content-Type-Options", "nosniff"); r.setHeader("Referrer-Policy", "no-referrer"); r.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'"); }
function allowedHost(value: string | undefined) { if (!value) return false; const m = value.match(/^(localhost|127\.0\.0\.1|::1)(?::(?:0|[1-9][0-9]{0,4}))?$/); return !!m; }
function json(r: ServerResponse, status: number, value: unknown, head: boolean) { r.statusCode = status; headers(r, "application/json; charset=utf-8"); r.end(head ? undefined : JSON.stringify(value)); }
function error(r: ServerResponse, status: number, code: string, message: string, head: boolean) { json(r, status, { error: { code, message } }, head); }
function decodeSegment(raw: string) { try { return decodeURIComponent(raw); } catch { return undefined; } }
export function createDashboardServer(options: DashboardServerOptions = {}): DashboardServer {
  const host = "127.0.0.1", repository = new SafeDashboardRunRepository(options.controllerRoot), frontend = resolve(options.frontendRoot ?? join(process.cwd(), "dist/frontend"));
  let resolveClosed!: () => void; let closedDone = false; const closed = new Promise<void>(r => { resolveClosed = r; });
  const markClosed = () => { if (!closedDone) { closedDone = true; resolveClosed(); } };
  const server = createServer(async (request, response) => { const head = request.method === "HEAD"; try {
    if (!allowedHost(request.headers.host)) return error(response, 403, "INVALID_HOST", "Invalid Host.", head);
    if (request.method !== "GET" && request.method !== "HEAD") return error(response, 405, "METHOD_NOT_ALLOWED", "Only GET and HEAD are supported.", false);
    const raw = request.url ?? "/";
    if (raw.includes("\0")) return error(response, 400, "INVALID_PATH", "Invalid path.", head);
    const api = raw.match(/^\/api\/runs\/([^/?#]+)(?:\?.*)?$/);
    if (raw === "/api/health" || raw.startsWith("/api/health?")) return json(response, 200, HEALTH, head);
    if (raw === "/api/runs" || raw.startsWith("/api/runs?")) return json(response, 200, await repository.listRuns(), head);
    if (api) { const id = decodeSegment(api[1]); if (!id || id.includes("\0") || id.includes("/") || id.includes("\\") || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(id)) return error(response, 400, "UNSAFE_COMPARISON_ID", "Unsafe comparison ID.", head); try { return json(response, 200, await repository.getRun(id), head); } catch (e) { const code = (e as { code?: string }).code; return error(response, code === "INVALID_RUN" ? 422 : code === "UNSAFE_COMPARISON_ID" ? 400 : 404, code === "INVALID_RUN" ? "INVALID_RUN" : code === "UNSAFE_COMPARISON_ID" ? "UNSAFE_COMPARISON_ID" : "UNKNOWN_COMPARISON_ID", code === "INVALID_RUN" ? "Persisted run is invalid." : code === "UNSAFE_COMPARISON_ID" ? "Unsafe comparison ID." : "Unknown comparison ID.", head); } }
    if (/(?:%2e|%2f|%5c)/i.test(raw) || raw.includes("..") || raw.includes("\\") || raw.startsWith("/~")) return error(response, 400, "INVALID_PATH", "Invalid path.", head);
    const path = new URL(raw, "http://localhost").pathname;
    const shell = path === "/" || path === "/compiler/" || path === "/experiment/" || path === "/evidence/" || path === "/runs/" || /^\/runs\/[A-Za-z0-9][A-Za-z0-9._:-]{0,119}\/$/.test(path);
    const name = shell ? (path.startsWith("/runs") ? "runs/index.html" : path === "/" ? "index.html" : path.slice(1) + "index.html") : path.slice(1);
    if (!shell && !path.startsWith("/assets/")) return error(response, 404, "NOT_FOUND", "Route not found.", head);
    const file = resolve(frontend, name), stat = await lstat(file).catch(() => undefined); const root = await realpath(frontend).catch(() => frontend); const actual = await realpath(file).catch(() => file);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || !MIME[extname(file)] || relative(root, actual).startsWith("..")) return error(response, 404, "NOT_FOUND", "Resource not found.", head);
    headers(response, MIME[extname(file)]); response.statusCode = 200; response.end(head ? undefined : await readFile(actual));
  } catch { error(response, 404, "NOT_FOUND", "Route not found.", head); } });
  const port = options.port ?? 4317;
  return { host, port, origin: `http://${host}:${port}`, server, closed, close: () => new Promise<void>(done => { if (!server.listening) { markClosed(); done(); } else server.close(() => { markClosed(); done(); }); }) };
}
export async function startDashboardServer(options: DashboardServerOptions = {}) { const dashboard = createDashboardServer(options); await new Promise<void>((ok, fail) => { dashboard.server.once("error", fail); dashboard.server.listen(dashboard.port, dashboard.host, ok); }); const address = dashboard.server.address(); if (address && typeof address !== "string") { dashboard.port = address.port; dashboard.origin = `http://${dashboard.host}:${dashboard.port}`; } return dashboard; }
export async function closeDashboardServer(server: DashboardServer) { await server.close(); }
