import { z } from "zod/v3";
import { ALIGNMENT_CLASSIFICATIONS, ANALYSIS_STATUSES, CONDITION_MEMBERSHIPS, EVIDENCE_STRENGTHS, IMPACT_DIRECTIONS, INSTRUCTION_EVIDENCE_SCHEMA_VERSION, type InstructionEvidenceBundle, type InstructionEvidenceRecord } from "./instruction-evidence-types.js";
import { InstructionEvidenceError } from "./instruction-evidence-errors.js";
const text = (max: number) => z.string().trim().min(1).max(max).refine(v => !v.includes("\0"));
const id = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).refine(v => !v.includes("\0"));
const ref = text(2048).refine(v => !v.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(v) && !v.includes("\\") && !v.split("/").includes(".."));
const range = z.object({ start: z.number().int().safe().positive(), end: z.number().int().safe().positive() }).strict().refine(v => v.start <= v.end);
const evidence = z.object({ evidenceId: id, relation: z.enum(["effect", "supporting", "contradicting"]), strength: z.enum(EVIDENCE_STRENGTHS), explanation: text(2000), sourceRef: ref, sourceRange: range.optional(), excerpt: text(4096).optional() }).strict();
export const instructionEvidenceSchema = z.object({ schemaVersion: z.literal(INSTRUCTION_EVIDENCE_SCHEMA_VERSION), instruction: z.object({ instructionId: id, identity: text(4096), provenance: z.object({ sourceRef: ref, sourceHash: text(256).optional(), sourceRange: range.optional() }).strict(), conditionMembership: z.enum(CONDITION_MEMBERSHIPS), included: z.boolean() }).strict(), alignment: z.object({ classification: z.enum(ALIGNMENT_CLASSIFICATIONS), explanation: text(2000) }).strict(), impact: z.object({ direction: z.enum(IMPACT_DIRECTIONS), explanation: text(2000) }).strict(), evidenceStrength: z.enum(EVIDENCE_STRENGTHS), evidence: z.array(evidence).max(128), limitations: z.array(text(2000)).max(32), analysisStatus: z.enum(ANALYSIS_STATUSES) }).strict();
export function validateInstructionEvidence(value: unknown): InstructionEvidenceRecord {
  const parsed = instructionEvidenceSchema.safeParse(value);
  if (!parsed.success) throw new InstructionEvidenceError("Instruction evidence schema is invalid.", "INVALID_SCHEMA", parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`));
  const d = parsed.data; const issues: string[] = []; const ids = new Set<string>();
  for (const e of d.evidence) { if (ids.has(e.evidenceId)) issues.push(`duplicate evidence ID '${e.evidenceId}'`); ids.add(e.evidenceId); if (e.excerpt && Buffer.byteLength(e.excerpt, "utf8") > 4096) issues.push(`oversized excerpt '${e.evidenceId}'`); }
  if (d.impact.direction === "helped" || d.impact.direction === "hurt") { if (d.evidenceStrength === "insufficient" || d.evidence.length === 0) issues.push("helped/hurt requires sufficient evidence"); }
  if (d.evidenceStrength === "direct" && !d.evidence.some(e => e.relation === "effect" && e.strength === "direct")) issues.push("direct strength requires direct effect evidence");
  if (d.evidenceStrength === "strongly-supported" && d.evidence.filter(e => e.relation !== "contradicting").length < 2) issues.push("strongly-supported requires multiple sources");
  if (d.evidenceStrength === "correlated" && d.limitations.length === 0) issues.push("correlated evidence requires a limitation");
  if (d.alignment.classification === "current" && !d.instruction.included) issues.push("current instruction must be included");
  const ordered = [...d.evidence].sort((a,b) => a.evidenceId.localeCompare(b.evidenceId)); if (ordered.some((e,i) => e.evidenceId !== d.evidence[i]?.evidenceId)) issues.push("evidence must use canonical ID order");
  if (issues.length) throw new InstructionEvidenceError("Instruction evidence semantics are invalid.", issues.some(i => i.includes("duplicate")) ? "DUPLICATE_ID" : "INVALID_SEMANTICS", issues);
  return d as InstructionEvidenceRecord;
}
export function canonicalizeInstructionEvidence(record: InstructionEvidenceRecord): InstructionEvidenceRecord { return { ...record, evidence: [...record.evidence].sort((a,b) => a.evidenceId.localeCompare(b.evidenceId)), limitations: [...record.limitations].sort() }; }
export function validateInstructionEvidenceBundle(value: unknown): InstructionEvidenceBundle {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.keys(value).every(k => k === "schemaVersion" || k === "records")) throw new InstructionEvidenceError("Instruction evidence bundle schema is invalid.", "INVALID_SCHEMA");
  const candidate = value as { schemaVersion?: unknown; records?: unknown };
  if (candidate.schemaVersion !== INSTRUCTION_EVIDENCE_SCHEMA_VERSION || !Array.isArray(candidate.records) || candidate.records.length === 0) throw new InstructionEvidenceError("Instruction evidence bundle schema is invalid.", "INVALID_SCHEMA");
  const records = candidate.records.map(validateInstructionEvidence); const seen = new Set<string>(); const duplicates: string[] = [];
  for (const record of records) { if (seen.has(record.instruction.instructionId)) duplicates.push(record.instruction.instructionId); seen.add(record.instruction.instructionId); }
  if (duplicates.length) throw new InstructionEvidenceError("Instruction evidence bundle contains duplicate instruction IDs.", "DUPLICATE_ID", duplicates);
  return { schemaVersion: INSTRUCTION_EVIDENCE_SCHEMA_VERSION, records };
}
