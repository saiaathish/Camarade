import { assertPublicEvidence } from "../artifacts/public-evidence-policy.js";
import { writeJsonExclusive } from "../artifacts/write-manifest.js";
import { writeSummary } from "../artifacts/write-summary.js";
import type { FairExperimentResult } from "./experiment-types.js";

export async function writeExperimentArtifacts(result: FairExperimentResult): Promise<void> {
  const directory = result.prepared?.layout.experimentDirectory;
  if (!directory) throw new Error("Prepared experiment is required");
  assertPublicEvidence(result.summary, "experiment-summary.json");
  await writeJsonExclusive(`${directory}/experiment-manifest.json`, result.manifest, "Experiment manifest");
  await writeSummary(`${directory}/experiment-summary.json`, result.summary);
  await writeJsonExclusive(`${directory}/experiment-result.json`, result, "Experiment result");
}
