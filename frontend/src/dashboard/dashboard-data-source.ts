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
