import { dashboardFixtureEmptyRunList, dashboardFixtureRuns } from "../generated/dashboard-fixtures";
import {
  DashboardRunNotFoundError,
  type DashboardDataSource,
} from "./dashboard-data-source";
import type { DashboardRun, DashboardRunSummary } from "./dashboard-types";

function toSummary(run: DashboardRun): DashboardRunSummary {
  return {
    schemaVersion: run.schemaVersion,
    comparisonId: run.comparisonId,
    task: run.task,
    repository: run.repository,
    timestamps: run.timestamps,
    status: run.status,
    outcome: run.outcome,
    progress: run.progress,
  };
}

/** Newest first; comparison ID ascending breaks identical timestamps. */
function compareSummaries(a: DashboardRunSummary, b: DashboardRunSummary): number {
  const byStarted = b.timestamps.startedAt.localeCompare(a.timestamps.startedAt);
  if (byStarted !== 0) return byStarted;
  return a.comparisonId.localeCompare(b.comparisonId);
}

interface FixtureDashboardDataSourceOptions {
  /** Deterministic QA mode backed by the canonical empty-run-list fixture. */
  emptyRunList: boolean;
}

export class FixtureDashboardDataSource implements DashboardDataSource {
  private readonly emptyRunList: boolean;

  constructor(options: FixtureDashboardDataSourceOptions) {
    this.emptyRunList = options.emptyRunList;
  }

  async listRuns(): Promise<DashboardRunSummary[]> {
    if (this.emptyRunList) return [...dashboardFixtureEmptyRunList];
    return dashboardFixtureRuns.map(toSummary).sort(compareSummaries);
  }

  async getRun(comparisonId: string): Promise<DashboardRun> {
    if (this.emptyRunList) throw new DashboardRunNotFoundError(comparisonId);
    const run = dashboardFixtureRuns.find((candidate) => candidate.comparisonId === comparisonId);
    if (!run) throw new DashboardRunNotFoundError(comparisonId);
    return run;
  }
}

/**
 * Creates the dashboard data source for this document.
 * S8-04 swaps this factory for a local API data source; components must not
 * depend on fixture behavior beyond the DashboardDataSource interface.
 */
export function createDashboardDataSource(search: string): DashboardDataSource {
  const params = new URLSearchParams(search);
  return new FixtureDashboardDataSource({ emptyRunList: params.get("fixture") === "empty" });
}
