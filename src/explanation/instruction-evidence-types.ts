export const INSTRUCTION_EVIDENCE_SCHEMA_VERSION = "1.0.0" as const;
export const ALIGNMENT_CLASSIFICATIONS = ["current", "stale", "irrelevant", "duplicate", "conflicting", "not-applied", "unresolved"] as const;
export const IMPACT_DIRECTIONS = ["helped", "hurt", "neutral", "unknown"] as const;
export const EVIDENCE_STRENGTHS = ["direct", "strongly-supported", "correlated", "insufficient"] as const;
export const ANALYSIS_STATUSES = ["complete", "limited", "invalid", "unresolved"] as const;
export const CONDITION_MEMBERSHIPS = ["baseline", "optimized", "both", "neither"] as const;
export type AlignmentClassification = typeof ALIGNMENT_CLASSIFICATIONS[number];
export type ImpactDirection = typeof IMPACT_DIRECTIONS[number];
export type EvidenceStrength = typeof EVIDENCE_STRENGTHS[number];
export type AnalysisStatus = typeof ANALYSIS_STATUSES[number];
export type ConditionMembership = typeof CONDITION_MEMBERSHIPS[number];
export interface EvidenceReference { evidenceId: string; relation: "effect" | "supporting" | "contradicting"; strength: EvidenceStrength; explanation: string; sourceRef: string; sourceRange?: { start: number; end: number }; excerpt?: string; }
export interface InstructionEvidenceRecord {
  schemaVersion: typeof INSTRUCTION_EVIDENCE_SCHEMA_VERSION;
  instruction: { instructionId: string; identity: string; provenance: { sourceRef: string; sourceHash?: string; sourceRange?: { start: number; end: number } }; conditionMembership: ConditionMembership; included: boolean; };
  alignment: { classification: AlignmentClassification; explanation: string; };
  impact: { direction: ImpactDirection; explanation: string; };
  evidenceStrength: EvidenceStrength;
  evidence: EvidenceReference[];
  limitations: string[];
  analysisStatus: AnalysisStatus;
}
export interface InstructionEvidenceBundle { schemaVersion: typeof INSTRUCTION_EVIDENCE_SCHEMA_VERSION; records: InstructionEvidenceRecord[]; }
