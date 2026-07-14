import type { ValidationResult } from "../core/types.js";

export const FIXTURE_ADAPTER_NOTICE =
  "Fixture adapter results are simulated and are not benchmark evidence.";

export interface RunComparisonEvidence {
  changedFiles: readonly string[];
  addedLines: number;
  deletedLines: number;
  dependencyFilesChanged: readonly string[];
  validationResults: readonly ValidationResult[];
  agentExitCode: number | null;
  durationMs: number;
}

export interface RawRunSummary {
  changedFiles: string[];
  changedFileCount: number;
  addedLines: number;
  deletedLines: number;
  totalDiffLines: number;
  dependencyFilesChanged: string[];
  dependencyFileCount: number;
  passedValidationCommands: string[];
  failedValidationCommands: string[];
  passedValidationCount: number;
  failedValidationCount: number;
  agentExitCode: number | null;
  totalDurationMs: number;
}

export interface RawMetricDelta {
  changedFileCount: number;
  addedLines: number;
  deletedLines: number;
  totalDiffLines: number;
  dependencyFileCount: number;
  passedValidationCount: number;
  failedValidationCount: number;
  totalDurationMs: number;
}

export interface RawRunComparison {
  notice: string;
  validationCommandsMatched: boolean;
  baseline: RawRunSummary;
  camarade: RawRunSummary;
  camaradeMinusBaseline: RawMetricDelta;
}

function summarize(run: RunComparisonEvidence): RawRunSummary {
  const passedValidationCommands = run.validationResults
    .filter((result) => result.exitCode === 0)
    .map((result) => result.command);
  const failedValidationCommands = run.validationResults
    .filter((result) => result.exitCode !== 0)
    .map((result) => result.command);

  return {
    changedFiles: [...run.changedFiles],
    changedFileCount: run.changedFiles.length,
    addedLines: run.addedLines,
    deletedLines: run.deletedLines,
    totalDiffLines: run.addedLines + run.deletedLines,
    dependencyFilesChanged: [...run.dependencyFilesChanged],
    dependencyFileCount: run.dependencyFilesChanged.length,
    passedValidationCommands,
    failedValidationCommands,
    passedValidationCount: passedValidationCommands.length,
    failedValidationCount: failedValidationCommands.length,
    agentExitCode: run.agentExitCode,
    totalDurationMs: run.durationMs
  };
}

function commandsMatch(
  baseline: readonly ValidationResult[],
  camarade: readonly ValidationResult[]
): boolean {
  return baseline.length === camarade.length && baseline.every(
    (result, index) => result.command === camarade[index]?.command
  );
}

export function compareRuns(
  baselineEvidence: RunComparisonEvidence,
  camaradeEvidence: RunComparisonEvidence,
  notice: string
): RawRunComparison {
  if (notice.trim() === "") throw new TypeError("Comparison notice must be non-empty.");
  const baseline = summarize(baselineEvidence);
  const camarade = summarize(camaradeEvidence);

  return {
    notice,
    validationCommandsMatched: commandsMatch(
      baselineEvidence.validationResults,
      camaradeEvidence.validationResults
    ),
    baseline,
    camarade,
    camaradeMinusBaseline: {
      changedFileCount: camarade.changedFileCount - baseline.changedFileCount,
      addedLines: camarade.addedLines - baseline.addedLines,
      deletedLines: camarade.deletedLines - baseline.deletedLines,
      totalDiffLines: camarade.totalDiffLines - baseline.totalDiffLines,
      dependencyFileCount: camarade.dependencyFileCount - baseline.dependencyFileCount,
      passedValidationCount: camarade.passedValidationCount - baseline.passedValidationCount,
      failedValidationCount: camarade.failedValidationCount - baseline.failedValidationCount,
      totalDurationMs: camarade.totalDurationMs - baseline.totalDurationMs
    }
  };
}
