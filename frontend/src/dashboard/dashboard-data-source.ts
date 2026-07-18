import type { DashboardRun, DashboardRunSummary } from "./dashboard-types";

/**
 * Data-source seam for the dashboard.
 * S8-03 ships a fixture-backed implementation; S8-04 replaces the factory
 * with a local API implementation without touching the components.
 */
export interface DashboardDataSource {
  listRuns(): Promise<DashboardRunSummary[]>;
  getRun(comparisonId: string): Promise<DashboardRun>;
}

export class DashboardApiError extends Error {
  constructor(readonly reason: "unavailable" | "invalid") {
    super(reason === "invalid" ? "The local dashboard returned an invalid response." : "The local dashboard service is unavailable.");
    this.name = "DashboardApiError";
  }
}

const SCHEMA_VERSION = "stage-8-dashboard.v1";
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function isRun(value: unknown): value is DashboardRun {
  return isRecord(value) && value.schemaVersion === SCHEMA_VERSION && typeof value.comparisonId === "string" &&
    typeof value.task === "string" && isRecord(value.repository) && isRecord(value.timestamps) &&
    typeof value.status === "string" && "outcome" in value && isRecord(value.progress) &&
    Array.isArray(value.conditions) && Array.isArray(value.limitations) && Array.isArray(value.artifacts) && Array.isArray(value.errors);
}
function isSummary(value: unknown): value is DashboardRunSummary {
  return isRecord(value) && value.schemaVersion === SCHEMA_VERSION && typeof value.comparisonId === "string" &&
    typeof value.task === "string" && isRecord(value.repository) && isRecord(value.timestamps) &&
    typeof value.status === "string" && "outcome" in value && isRecord(value.progress);
}

export class LocalApiDashboardDataSource implements DashboardDataSource {
  private async request(path: string): Promise<unknown> {
    try {
      const response = await fetch(path, { cache: "no-store" });
      if (response.status === 404) throw new DashboardRunNotFoundError(path.split("/").pop() ?? "");
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !type.toLowerCase().includes("application/json")) throw new DashboardApiError("unavailable");
      let body: unknown;
      try { body = await response.json(); } catch { throw new DashboardApiError("invalid"); }
      return body;
    } catch (error) {
      if (error instanceof DashboardRunNotFoundError || error instanceof DashboardApiError) throw error;
      throw new DashboardApiError("unavailable");
    }
  }
  async listRuns(): Promise<DashboardRunSummary[]> {
    const body = await this.request("/api/runs");
    if (!Array.isArray(body) || !body.every(isSummary)) throw new DashboardApiError("invalid");
    return body;
  }
  async getRun(comparisonId: string): Promise<DashboardRun> {
    const body = await this.request(`/api/runs/${encodeURIComponent(comparisonId)}`);
    if (!isRun(body)) throw new DashboardApiError("invalid");
    return body;
  }
}

export class DashboardRunNotFoundError extends Error {
  readonly comparisonId: string;

  constructor(comparisonId: string) {
    super(`No run recorded for comparison "${comparisonId}".`);
    this.name = "DashboardRunNotFoundError";
    this.comparisonId = comparisonId;
  }
}

/**
 * Safe comparison IDs match the backend identifier constraints:
 * 1-120 characters, starting alphanumeric, then alphanumeric plus . _ : -
 */
export const DASHBOARD_COMPARISON_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export function isSafeDashboardComparisonId(value: string): boolean {
  return DASHBOARD_COMPARISON_ID_PATTERN.test(value);
}

/** Decodes one URL path segment without throwing on malformed input. */
export function decodeComparisonIdSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
