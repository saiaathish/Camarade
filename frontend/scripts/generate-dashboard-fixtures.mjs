// Deterministic build-time generator for the Stage 8 dashboard fixtures.
// Reads the canonical root fixtures and emits one frontend TypeScript module.
// Source of truth: src/dashboard/contract.ts
// Schema version: stage-8-dashboard.v1
//
// Failure modes (all exit non-zero and fail the frontend build):
//   - a canonical fixture file is missing or is not valid JSON
//   - a fixture has the wrong schema version
//   - two fixtures share a comparison ID
//   - a fixture breaks the public Stage 8 enum or state rules

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = "stage-8-dashboard.v1";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(scriptDir, "..");
const repositoryRoot = path.resolve(frontendRoot, "..");
const fixtureDir = path.join(repositoryRoot, "fixtures", "stage-8", "dashboard");
const outputDir = path.join(frontendRoot, "src", "generated");
const outputFile = path.join(outputDir, "dashboard-fixtures.ts");

const RUN_FIXTURE_NAMES = [
  "valid-camarade-win",
  "valid-tie",
  "valid-regression",
  "limited",
  "invalid",
  "running",
  "failed",
];
const EMPTY_LIST_FIXTURE_NAME = "empty-run-list";

const STATUSES = new Set(["running", "valid", "limited", "invalid", "failed"]);
const OUTCOMES = new Set(["win", "tie", "regression"]);
const CONDITIONS = new Set(["baseline", "camarade"]);
const PROGRESS_STAGES = new Set([
  "preflight",
  "repository-intelligence",
  "context-compilation",
  "experiment-preparation",
  "baseline-execution",
  "camarade-execution",
  "measurement",
  "instruction-explanation",
  "finalization",
  "complete",
  "failed",
]);
const CLASSIFICATIONS = new Set(["current", "stale", "irrelevant", "duplicate", "conflicting", "not-applied", "unresolved"]);
const DIRECTIONS = new Set(["helped", "hurt", "neutral", "unknown"]);
const STRENGTHS = new Set(["direct", "strongly-supported", "correlated", "insufficient"]);
const SCORE_CATEGORIES = new Set(["correctness", "requirement-completion", "instruction-compliance", "change-focus", "efficiency"]);
const NUMERIC_STATUSES = new Set(["measured", "unavailable", "not-applicable"]);
const CHECK_RESULTS = new Set(["pass", "fail", "unavailable", "error"]);
const COMPARISON_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

function fail(message) {
  process.stderr.write(`generate-dashboard-fixtures: ${message}\n`);
  process.exit(1);
}

async function readFixture(name) {
  const file = path.join(fixtureDir, `${name}.json`);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    fail(`missing canonical fixture fixtures/stage-8/dashboard/${name}.json`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(`fixture fixtures/stage-8/dashboard/${name}.json is not valid JSON`);
  }
}

function assertEnum(value, set, label, fixtureName) {
  if (typeof value !== "string" || !set.has(value)) {
    fail(`${fixtureName}: ${label} has unsupported value ${JSON.stringify(value)}`);
  }
}

function assertNumericState(holder, label, fixtureName) {
  assertEnum(holder.status, NUMERIC_STATUSES, `${label}.status`, fixtureName);
  if (holder.status === "measured" && typeof holder.value !== "number") {
    fail(`${fixtureName}: ${label} is measured but has no numeric value`);
  }
  if (holder.status !== "measured" && holder.value !== null) {
    fail(`${fixtureName}: ${label} is ${holder.status} but carries a value`);
  }
}

function validateRun(run, fixtureName, seenIds) {
  if (run === null || typeof run !== "object" || Array.isArray(run)) {
    fail(`${fixtureName}: fixture is not an object`);
  }
  if (run.schemaVersion !== SCHEMA_VERSION) {
    fail(`${fixtureName}: wrong schema version ${JSON.stringify(run.schemaVersion)} (expected ${SCHEMA_VERSION})`);
  }
  if (typeof run.comparisonId !== "string" || !COMPARISON_ID_PATTERN.test(run.comparisonId)) {
    fail(`${fixtureName}: unsafe or missing comparison ID`);
  }
  if (seenIds.has(run.comparisonId)) {
    fail(`duplicate comparison ID ${JSON.stringify(run.comparisonId)} across fixtures`);
  }
  seenIds.add(run.comparisonId);

  assertEnum(run.status, STATUSES, "status", fixtureName);
  if (run.status === "valid" && !OUTCOMES.has(run.outcome)) {
    fail(`${fixtureName}: valid run requires outcome win, tie, or regression`);
  }
  if (run.status !== "valid" && run.outcome !== null) {
    fail(`${fixtureName}: non-valid run must keep outcome null`);
  }

  if (run.progress === null || typeof run.progress !== "object") fail(`${fixtureName}: missing progress`);
  assertEnum(run.progress.stage, PROGRESS_STAGES, "progress.stage", fixtureName);
  if (!Number.isInteger(run.progress.percent) || run.progress.percent < 0 || run.progress.percent > 100) {
    fail(`${fixtureName}: progress.percent must be an integer within 0-100`);
  }

  for (const flag of ["simulation", "realModel", "network"]) {
    if (typeof run[flag] !== "boolean") fail(`${fixtureName}: ${flag} must be a boolean`);
  }

  if (!Array.isArray(run.conditions) || run.conditions.length !== 2) {
    fail(`${fixtureName}: conditions must contain exactly baseline and camarade`);
  }
  const names = run.conditions.map((condition) => condition?.condition);
  if (new Set(names).size !== 2 || !names.every((name) => CONDITIONS.has(name))) {
    fail(`${fixtureName}: conditions must be exactly baseline and camarade`);
  }
  for (const condition of run.conditions) {
    const label = `conditions.${condition.condition}`;
    assertEnum(condition.status, STATUSES, `${label}.status`, fixtureName);
    assertEnum(condition.evidenceQuality, STRENGTHS, `${label}.evidenceQuality`, fixtureName);
    for (const score of condition.scores ?? []) {
      assertEnum(score.category, SCORE_CATEGORIES, `${label}.scores[].category`, fixtureName);
      assertNumericState(score, `${label}.scores[${score.category}]`, fixtureName);
    }
    for (const metric of condition.metrics ?? []) assertNumericState(metric, `${label}.metrics[]`, fixtureName);
    for (const check of condition.checks ?? []) assertEnum(check.result, CHECK_RESULTS, `${label}.checks[].result`, fixtureName);
    for (const impact of condition.impacts ?? []) {
      assertEnum(impact.classification, CLASSIFICATIONS, `${label}.impacts[].classification`, fixtureName);
      assertEnum(impact.direction, DIRECTIONS, `${label}.impacts[].direction`, fixtureName);
      assertEnum(impact.evidenceStrength, STRENGTHS, `${label}.impacts[].evidenceStrength`, fixtureName);
    }
  }
  return run;
}

function validateSummary(summary, fixtureName) {
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) {
    fail(`${fixtureName}: summary is not an object`);
  }
  if (summary.schemaVersion !== SCHEMA_VERSION) {
    fail(`${fixtureName}: wrong schema version ${JSON.stringify(summary.schemaVersion)} (expected ${SCHEMA_VERSION})`);
  }
  if (typeof summary.comparisonId !== "string" || !COMPARISON_ID_PATTERN.test(summary.comparisonId)) {
    fail(`${fixtureName}: unsafe or missing comparison ID`);
  }
}

const seenIds = new Set();
const runs = [];
for (const name of RUN_FIXTURE_NAMES) {
  runs.push(validateRun(await readFixture(name), name, seenIds));
}

const emptyRunList = await readFixture(EMPTY_LIST_FIXTURE_NAME);
if (!Array.isArray(emptyRunList)) fail(`${EMPTY_LIST_FIXTURE_NAME}: fixture must be an array of run summaries`);
emptyRunList.forEach((summary) => validateSummary(summary, EMPTY_LIST_FIXTURE_NAME));

const header = `/**
 * GENERATED FILE — DO NOT EDIT.
 * Generated by frontend/scripts/generate-dashboard-fixtures.mjs from the
 * canonical fixtures under fixtures/stage-8/dashboard/.
 * Source of truth: src/dashboard/contract.ts
 * Schema version: stage-8-dashboard.v1
 */
import type { DashboardRun, DashboardRunSummary } from "../dashboard/dashboard-types";

export const DASHBOARD_FIXTURE_SCHEMA_VERSION = ${JSON.stringify(SCHEMA_VERSION)} as const;
`;

const body = `
export const dashboardFixtureRuns: DashboardRun[] = ${JSON.stringify(runs, null, 2)};

export const dashboardFixtureEmptyRunList: DashboardRunSummary[] = ${JSON.stringify(emptyRunList, null, 2)};
`;

await mkdir(outputDir, { recursive: true });
await writeFile(outputFile, `${header}${body}`, "utf8");
process.stdout.write(
  `generate-dashboard-fixtures: wrote ${path.relative(repositoryRoot, outputFile)} (${runs.length} runs, ${emptyRunList.length} empty-list entries, schema ${SCHEMA_VERSION})\n`,
);
