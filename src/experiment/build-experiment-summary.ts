import type { ExperimentSummary } from "./experiment-types.js";
export function buildExperimentSummary(summary: ExperimentSummary): ExperimentSummary { return {...summary, artifacts:[...(summary.artifacts ?? [])].sort()}; }
