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
      compilerPhase: document.querySelector(".compiler")?.getAttribute("data-phase"),
      replayDisabled: document.querySelector(".replay-button")?.disabled,
      replayAriaDisabled: document.querySelector(".replay-button")?.getAttribute("aria-disabled"),
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
await desktopPage.waitForTimeout(3500);
await inspectPage(desktopPage, report.desktop);

await desktopPage.screenshot({ path: path.join(outputDir, `desktop-hero-${label}.png`) });
await desktopPage.screenshot({ path: path.join(outputDir, `desktop-full-${label}.png`), fullPage: true });

const replay = desktopPage.getByRole("button", { name: /replay/i });
await replay.click();
try {
  await desktopPage.waitForFunction(
    () => document.querySelector(".replay-button")?.getAttribute("aria-disabled") === "true",
    null,
    { timeout: 750 },
  );
  report.desktop.replayDisabledDuringRun = true;
} catch {
  report.desktop.replayDisabledDuringRun = false;
}
await desktopPage.locator('.compiler[data-phase="done"]').waitFor({ state: "attached", timeout: 5000 });
report.desktop.compilerPhaseAfterReplay = await desktopPage.locator(".compiler").getAttribute("data-phase");
report.desktop.focusAfterReplay = await desktopPage.evaluate(() => document.activeElement?.className);

const sequenceBeforeRapidActivation = Number(await desktopPage.locator(".compiler").getAttribute("data-run"));
await desktopPage.evaluate(() => {
  const button = document.querySelector(".replay-button");
  button?.click();
  button?.click();
  button?.click();
});
await desktopPage.waitForFunction(
  (expectedSequence) => {
    const compiler = document.querySelector(".compiler");
    return (
      Number(compiler?.getAttribute("data-run")) === expectedSequence &&
      compiler?.getAttribute("data-phase") === "done"
    );
  },
  sequenceBeforeRapidActivation + 1,
  { timeout: 5000 },
);
const sequenceAfterRapidActivation = Number(await desktopPage.locator(".compiler").getAttribute("data-run"));
report.desktop.rapidActivationSequenceCount = sequenceAfterRapidActivation - sequenceBeforeRapidActivation;

const compiledToggle = desktopPage.getByRole("button", { name: "Camarade contract" });
const rawToggle = desktopPage.getByRole("button", { name: "Raw context" });
await compiledToggle.click();
await rawToggle.click();
await compiledToggle.click();
report.desktop.compiledPressedAfterRapidToggle = await compiledToggle.getAttribute("aria-pressed");
await desktopPage.locator("#context-diff").scrollIntoViewIfNeeded();
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

await desktopPage.addScriptTag({ path: axePath });
const axeResult = await desktopPage.evaluate(async () => {
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
report.axe = axeResult;
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
await mobilePage.locator(".compiler-shell").scrollIntoViewIfNeeded();
await mobilePage.locator('.compiler[data-phase="done"]').waitFor({ state: "attached", timeout: 5000 });
await inspectPage(mobilePage, report.mobile);
await mobilePage.evaluate(() => window.scrollTo(0, 0));
await mobilePage.waitForTimeout(120);
await mobilePage.screenshot({ path: path.join(outputDir, `mobile-full-${label}.png`), fullPage: true });
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
  await page.locator(".compiler-shell").scrollIntoViewIfNeeded();
  await page.locator('.compiler[data-phase="done"]').waitFor({ state: "attached", timeout: 5000 });
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
await reducedPage.goto(baseUrl, { waitUntil: "networkidle" });
await reducedPage.waitForTimeout(300);
report.reducedMotion = await reducedPage.evaluate(() => ({
  compilerPhase: document.querySelector(".compiler")?.getAttribute("data-phase"),
  controlText: document.querySelector(".motion-status")?.textContent?.trim().replace(/\s+/g, " "),
  rawRejectedOpacity: getComputedStyle(document.querySelector(".raw-rule--reject")).opacity,
  contractOpacity: getComputedStyle(document.querySelector(".contract-rule")).opacity,
}));
await reducedPage.screenshot({ path: path.join(outputDir, `reduced-hero-${label}.png`) });
await reducedContext.close();
report.diagnostics = {
  consoleErrorCount: report.consoleErrors.length,
  pageErrorCount: report.pageErrors.length,
  failedRequestCount: report.requestsFailed.length,
  httpErrorCount: report.httpErrors.length,
};

const viewportReports = [report.desktop, report.mobile, report.narrow, report.intermediate, report.zoomEquivalent];
const failures = [];

if (report.consoleErrors.length) failures.push("console errors");
if (report.pageErrors.length) failures.push("page errors");
if (report.requestsFailed.length) failures.push("failed requests");
if (report.httpErrors.length) failures.push("HTTP error responses");
if (report.axe.length) failures.push("axe violations");
if (viewportReports.some((viewport) => viewport.horizontalOverflow)) failures.push("horizontal overflow");
if (viewportReports.some((viewport) => viewport.svgCount !== 0)) failures.push("SVG elements present");
if (viewportReports.some((viewport) => viewport.githubLinks < 1)) failures.push("canonical GitHub link missing");
if (viewportReports.some((viewport) => viewport.invalidHashLinks?.length)) failures.push("invalid hash links");
if (viewportReports.some((viewport) => viewport.invalidGithubLinks?.length)) failures.push("invalid GitHub links");
if (viewportReports.some((viewport) => viewport.placeholderLinks?.length)) failures.push("placeholder links");
if (!report.desktop.replayDisabledDuringRun) failures.push("replay control stays enabled while running");
if (report.desktop.compilerPhaseAfterReplay !== "done") failures.push("replay does not complete");
if (report.desktop.focusAfterReplay !== "replay-button") failures.push("replay loses keyboard focus");
if (report.desktop.rapidActivationSequenceCount !== 1) failures.push("rapid activation starts multiple runs");
if (report.desktop.compiledPressedAfterRapidToggle !== "true") failures.push("diff toggle state is unstable");
if (report.reducedMotion.compilerPhase !== "done") failures.push("reduced-motion final state missing");

report.failures = failures;
const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
await writeFile(path.join(outputDir, `report-${label}.json`), serializedReport, "utf8");
await browser.close();
process.stdout.write(serializedReport);
if (failures.length) process.exitCode = 1;
