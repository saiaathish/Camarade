import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboardServer } from "../../dist/src/dashboard-server/index.js";
import { LocalApiDashboardDataSource, DashboardApiError, DashboardRunNotFoundError } from "../src/dashboard/dashboard-data-source.ts";
import { chromium } from "playwright-core";

const root = await mkdtemp(join(tmpdir(), "camarade-s8-04-"));
await mkdir(join(root, ".camarade", "runs", "win-001"), { recursive: true });
await cp(new URL("../../fixtures/stage-8/dashboard/valid-camarade-win.json", import.meta.url), join(root, ".camarade", "runs", "win-001", "dashboard-run.json"));
await mkdir(join(root, ".camarade", "runs", "limited-001"), { recursive: true });
await cp(new URL("../../fixtures/stage-8/dashboard/limited.json", import.meta.url), join(root, ".camarade", "runs", "limited-001", "dashboard-run.json"));
const server = await startDashboardServer({ controllerRoot: root, frontendRoot: new URL("../dist", import.meta.url).pathname, port: 0 });
const base = server.origin + "/";
try {
  const source = new LocalApiDashboardDataSource();
  const nodeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => nodeFetch(new URL(String(input), base), init);
  const runs = await source.listRuns(); assert.ok(runs.some((run) => run.comparisonId === "win-001")); // [S8F01]
  const run = await source.getRun("win-001"); assert.equal(run.comparisonId, "win-001"); // [S8F02]
  const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage();
  await page.goto(base + "runs/win-001/"); await page.locator(".run-detail-header").waitFor(); assert.match(await page.locator("body").innerText(), /Local run data/); // [S8F03]
  await page.goto(base + "runs/?fixture=all"); assert.match(await page.locator("body").innerText(), /Simulated fixture data/); // [S8F04]
  await page.goto(base + "runs/?fixture=empty"); assert.match(await page.locator("body").innerText(), /No runs to display/); // [S8F05]
  let releaseList;
  const listHeld = new Promise((resolve) => { releaseList = resolve; });
  await page.route("**/api/runs", async (route) => { await listHeld; await route.continue(); });
  const loadingNavigation = page.goto(base + "runs/", { waitUntil: "domcontentloaded" });
  await page.locator('[data-state="loading"]').waitFor(); assert.equal(await page.locator('[data-state="loading"]').count(), 1); // [S8F06]
  releaseList(); await loadingNavigation; await page.locator(".run-list").waitFor(); assert.ok(await page.locator(".run-row").count() > 0);
  await page.unroute("**/api/runs");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  await assert.rejects(() => new LocalApiDashboardDataSource().listRuns(), (error) => error instanceof DashboardApiError && error.reason === "unavailable"); // [S8F07]
  globalThis.fetch = originalFetch;
  await page.goto(base + "runs/no-such-real-run/"); assert.match(await page.locator("body").innerText(), /No run matches/); // [S8F08]
  let retryAttempt = 0;
  globalThis.fetch = async (input, init) => { retryAttempt += 1; if (retryAttempt === 1) throw new TypeError("temporary outage"); return nodeFetch(new URL(String(input), base), init); };
  await assert.rejects(() => new LocalApiDashboardDataSource().listRuns(), DashboardApiError); const recovered = await new LocalApiDashboardDataSource().listRuns(); assert.ok(recovered.length > 0); // [S8F09]
  globalThis.fetch = async () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(() => new LocalApiDashboardDataSource().listRuns(), (error) => error instanceof DashboardApiError && error.reason === "invalid"); // [S8F10]
  globalThis.fetch = async () => new Response(JSON.stringify([{ schemaVersion: "wrong" }]), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(() => new LocalApiDashboardDataSource().listRuns(), (error) => error instanceof DashboardApiError && error.reason === "invalid"); // [S8F11]
  globalThis.fetch = originalFetch;
  await page.goto(base + "runs/limited-001/"); await page.locator(".run-detail-header").waitFor(); const limitedText = await page.locator("body").innerText(); assert.match(limitedText, /No outcome — limited evidence/); assert.doesNotMatch(limitedText, /Camarade wins|winner/); // [S8F12]
  await browser.close();
} finally { await server.close(); await rm(root, { recursive: true, force: true }); }
console.log("S8-04 local API assertions: 12/12");
