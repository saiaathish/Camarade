import type { InstructionEvidenceBundle, InstructionEvidenceRecord } from "./instruction-evidence-types.js";

export interface InstructionImpactInput {
  instructions: readonly unknown[];
  baseline?: unknown;
  optimized?: unknown;
  repository?: unknown;
  task?: string;
  experimentStatus?: "valid" | "limited" | "invalid";
}
export type InstructionImpactResult = InstructionEvidenceBundle;
export type InstructionImpactRecord = InstructionEvidenceRecord;
