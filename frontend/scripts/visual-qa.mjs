import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:5173/";
const label = process.argv[2] ?? "capture";
const outputDir = path.resolve(".artifacts/qa");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const routeCases = [
  { path: "/compiler/", label: "Compiler", file: "compiler" },
  { path: "/experiment/", label: "Compare", file: "experiment" },
  { path: "/evidence/", label: "Evidence", file: "evidence" },
];
const routeUrl = (pathname) => new URL(pathname, baseUrl).href;

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--disable-gpu"],
});

const report = {
  label,
  url: baseUrl,
  consoleErrors: [],
  pageErrors: [],
  requestsFailed: [],
  httpErrors: [],
  desktop: {},
  mobile: {},
  narrow: {},
  intermediate: {},
  zoomEquivalent: {},
  reducedMotion: {},
  compressionAnimation: {},
  routes: {},
  mobileRoutes: {},
  keyboardPath: [],
  axe: [],
};

async function attachDiagnostics(page) {
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    report.requestsFailed.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "failed"}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      report.httpErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
}

async function inspectPage(page, bucket) {
  Object.assign(
    bucket,
    await page.evaluate(() => ({
      title: document.title,
      headingOrder: [...document.querySelectorAll("h1, h2, h3")].map((heading) => ({
        level: heading.tagName,
        text: heading.textContent?.trim().replace(/\s+/g, " "),
      })),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      svgCount: document.querySelectorAll("svg").length,
      githubLinks: [...document.querySelectorAll('a[href*="github.com/saiaathish/Camarade"]')].length,
      invalidHashLinks: [...document.querySelectorAll('a[href^="#"]')]
        .map((link) => link.getAttribute("href"))
        .filter((href) => !href || href === "#" || !document.querySelector(href)),
      invalidGithubLinks: [...document.querySelectorAll('a[href*="github.com/saiaathish/Camarade"]')]
        .filter((link) => {
          const rel = link.getAttribute("rel")?.split(/\s+/) ?? [];
          return (
            link.getAttribute("href") !== "https://github.com/saiaathish/Camarade" ||
            link.getAttribute("target") !== "_blank" ||
            !rel.includes("noreferrer")
          );
        })
        .map((link) => link.outerHTML),
      placeholderLinks: [...document.querySelectorAll("a")]
        .filter((link) => !link.getAttribute("href") || link.getAttribute("href") === "#")
        .map((link) => link.outerHTML),
      mainWordCount: (document.querySelector("main")?.innerText ?? "").trim().split(/\s+/).filter(Boolean).length,
      sectionCount: document.querySelectorAll("main > section").length,
      pathname: window.location.pathname,
      activeNavigation: document.querySelector('nav a[aria-current="page"]')?.textContent?.trim() ?? null,
    })),
  );
}

const desktopContext = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  colorScheme: "light",
});
const desktopPage = await desktopContext.newPage();
attachDiagnostics(desktopPage);
await desktopPage.goto(baseUrl, { waitUntil: "networkidle" });
await desktopPage.waitForTimeout(500);
await inspectPage(desktopPage, report.desktop);

await desktopPage.screenshot({ path: path.join(outputDir, `desktop-hero-${label}.png`) });
await desktopPage.screenshot({ path: path.join(outputDir, `desktop-full-${label}.png`), fullPage: true });

await desktopPage.goto(routeUrl("/compiler/"), { waitUntil: "networkidle" });
const compressionMetrics = await desktopPage.locator(".context-scroll-story").evaluate((element) => ({
  top: element.offsetTop,
  travel: Math.max(element.offsetHeight - window.innerHeight + 84, 1),
}));
for (const [key, ratio] of [["start", 0], ["middle", 0.48], ["end", 1]]) {
  await desktopPage.evaluate(({ top, travel, ratio }) => window.scrollTo(0, top - 84 + travel * ratio), {
    ...compressionMetrics,
    ratio,
  });
  await desktopPage.waitForTimeout(180);
  report.compressionAnimation[key] = await desktopPage.locator(".context-scroll-story").evaluate((element) => ({
    phase: element.getAttribute("data-phase"),
    progress: Number.parseFloat(getComputedStyle(element).getPropertyValue("--compression-progress")),
    rawOpacity: Number.parseFloat(getComputedStyle(element.querySelector(".context-layer--raw")).opacity),
    cleanOpacity: Number.parseFloat(getComputedStyle(element.querySelector(".context-layer--clean")).opacity),
  }));
  if (key === "middle") {
    await desktopPage.screenshot({ path: path.join(outputDir, `desktop-compression-middle-${label}.png`) });
  }
}

for (const routeCase of routeCases) {
  await desktopPage.goto(baseUrl, { waitUntil: "networkidle" });
  await Promise.all([
    desktopPage.waitForURL(routeUrl(routeCase.path)),
    desktopPage.getByRole("link", { name: routeCase.label, exact: true }).click(),
  ]);
  const routeReport = {};
  await inspectPage(desktopPage, routeReport);
  routeReport.navigationType = await desktopPage.evaluate(
    () => performance.getEntriesByType("navigation")[0]?.type ?? null,
  );
  report.routes[routeCase.label] = routeReport;
  await desktopPage.waitForTimeout(600);
  await desktopPage.screenshot({
    path: path.join(outputDir, `desktop-${routeCase.file}-${label}.png`),
    fullPage: true,
  });
}

await desktopPage.goto(routeUrl("/compiler/"), { waitUntil: "networkidle" });
await desktopPage.locator(".diff-section").scrollIntoViewIfNeeded();
await desktopPage.waitForTimeout(550);
await desktopPage.screenshot({ path: path.join(outputDir, `desktop-diff-${label}.png`) });

await desktopPage.goto(baseUrl, { waitUntil: "networkidle" });
for (let index = 0; index < 9; index += 1) {
  await desktopPage.keyboard.press("Tab");
  report.keyboardPath.push(
    await desktopPage.evaluate(() => {
      const active = document.activeElement;
      return {
        tag: active?.tagName,
        text: active?.textContent?.trim().replace(/\s+/g, " ").slice(0, 80),
        href: active instanceof HTMLAnchorElement ? active.getAttribute("href") : null,
      };
    }),
  );
}

for (const pathname of ["/", ...routeCases.map((routeCase) => routeCase.path)]) {
  await desktopPage.goto(routeUrl(pathname), { waitUntil: "networkidle" });
  await desktopPage.addScriptTag({ path: axePath });
  const violations = await desktopPage.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        failureSummary: node.failureSummary,
      })),
    }));
  });
  report.axe.push({ path: pathname, violations });
}
await desktopContext.close();

const mobileContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  hasTouch: true,
  isMobile: true,
});
const mobilePage = await mobileContext.newPage();
attachDiagnostics(mobilePage);
await mobilePage.goto(baseUrl, { waitUntil: "networkidle" });
await mobilePage.waitForTimeout(500);
await mobilePage.screenshot({ path: path.join(outputDir, `mobile-hero-${label}.png`) });
await inspectPage(mobilePage, report.mobile);
await mobilePage.evaluate(() => window.scrollTo(0, 0));
await mobilePage.waitForTimeout(120);
await mobilePage.screenshot({ path: path.join(outputDir, `mobile-full-${label}.png`), fullPage: true });
for (const routeCase of routeCases) {
  await mobilePage.goto(routeUrl(routeCase.path), { waitUntil: "networkidle" });
  const routeReport = {};
  await inspectPage(mobilePage, routeReport);
  report.mobileRoutes[routeCase.label] = routeReport;
}
await mobileContext.close();

for (const viewportCase of [
  { key: "narrow", width: 320, height: 800, file: "narrow" },
  { key: "intermediate", width: 768, height: 1024, file: "intermediate" },
  { key: "zoomEquivalent", width: 640, height: 450, file: "zoom-200" },
]) {
  const context = await browser.newContext({
    viewport: { width: viewportCase.width, height: viewportCase.height },
    deviceScaleFactor: 1,
    colorScheme: "light",
  });
  const page = await context.newPage();
  attachDiagnostics(page);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await inspectPage(page, report[viewportCase.key]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(120);
  await page.screenshot({
    path: path.join(outputDir, `${viewportCase.file}-full-${label}.png`),
    fullPage: true,
  });
  await context.close();
}

const reducedContext = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  reducedMotion: "reduce",
  colorScheme: "light",
});
const reducedPage = await reducedContext.newPage();
attachDiagnostics(reducedPage);
await reducedPage.goto(routeUrl("/compiler/"), { waitUntil: "networkidle" });
await reducedPage.waitForTimeout(300);
report.reducedMotion = await reducedPage.evaluate(() => ({
  rawOpacity: getComputedStyle(document.querySelector(".context-layer--raw")).opacity,
  cleanOpacity: getComputedStyle(document.querySelector(".context-layer--clean")).opacity,
  storyHeight: getComputedStyle(document.querySelector(".context-scroll-story")).height,
}));
await reducedPage.screenshot({ path: path.join(outputDir, `reduced-hero-${label}.png`) });
await reducedContext.close();
report.diagnostics = {
  consoleErrorCount: report.consoleErrors.length,
  pageErrorCount: report.pageErrors.length,
  failedRequestCount: report.requestsFailed.length,
  httpErrorCount: report.httpErrors.length,
};

const routeReports = [...Object.values(report.routes), ...Object.values(report.mobileRoutes)];
const viewportReports = [report.desktop, report.mobile, report.narrow, report.intermediate, report.zoomEquivalent, ...routeReports];
const failures = [];

if (report.consoleErrors.length) failures.push("console errors");
if (report.pageErrors.length) failures.push("page errors");
if (report.requestsFailed.length) failures.push("failed requests");
if (report.httpErrors.length) failures.push("HTTP error responses");
if (report.axe.some((entry) => entry.violations.length)) failures.push("axe violations");
if (viewportReports.some((viewport) => viewport.horizontalOverflow)) failures.push("horizontal overflow");
if (viewportReports.some((viewport) => viewport.svgCount !== 0)) failures.push("SVG elements present");
if (viewportReports.some((viewport) => viewport.githubLinks < 1)) failures.push("canonical GitHub link missing");
if (viewportReports.some((viewport) => viewport.invalidHashLinks?.length)) failures.push("invalid hash links");
if (viewportReports.some((viewport) => viewport.invalidGithubLinks?.length)) failures.push("invalid GitHub links");
if (viewportReports.some((viewport) => viewport.placeholderLinks?.length)) failures.push("placeholder links");
if (routeCases.some((routeCase) => report.routes[routeCase.label]?.pathname !== routeCase.path)) failures.push("document route mismatch");
if (routeCases.some((routeCase) => report.routes[routeCase.label]?.activeNavigation !== routeCase.label)) failures.push("active navigation mismatch");
if (routeCases.some((routeCase) => report.routes[routeCase.label]?.navigationType !== "navigate")) failures.push("navigation did not load a document");
if (report.reducedMotion.rawOpacity !== "1" || report.reducedMotion.cleanOpacity !== "1") failures.push("reduced-motion context states are hidden");
if (report.compressionAnimation.start?.phase !== "original") failures.push("compression animation does not start with original context");
if (report.compressionAnimation.middle?.phase !== "cleaning") failures.push("compression animation does not expose a cleaning phase");
if (report.compressionAnimation.end?.phase !== "compressed") failures.push("compression animation does not finish with compressed context");

report.failures = failures;
const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
await writeFile(path.join(outputDir, `report-${label}.json`), serializedReport, "utf8");
await browser.close();
process.stdout.write(serializedReport);
if (failures.length) process.exitCode = 1;
