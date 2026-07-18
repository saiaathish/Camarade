import type { AlignmentClassification } from "./instruction-evidence-types.js";
export const classifyAlignment = (input: { included: boolean; irrelevant: boolean; duplicate: boolean; conflicting: boolean; stale: boolean; membership: string; }): { classification: AlignmentClassification; explanation: string } => {
  if (input.stale) return { classification: "stale", explanation: "Repository facts identify an active replacement for the named removed architecture." };
  if (input.irrelevant) return { classification: "irrelevant", explanation: "Structured task-scope evidence excludes this instruction." };
  if (input.duplicate) return { classification: "duplicate", explanation: "Another instruction has the same normalized identity." };
  if (input.conflicting) return { classification: "conflicting", explanation: "Structured opposing requirements conflict." };
  if (!input.included) return { classification: "not-applied", explanation: "The instruction was excluded from the analyzed condition." };
  if (input.membership === "neither") return { classification: "unresolved", explanation: "The included instruction is absent from both persisted condition sets." };
  return { classification: "current", explanation: "The instruction is present in persisted condition evidence." };
};
