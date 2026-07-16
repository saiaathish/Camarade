import { ContextCompilationError } from "../core/errors.js";
import type {
  ContextDecision,
  ContextReasoningDecision,
  ContextReasoningRequest,
  ContextReasoningResponse,
  ContextRelevance
} from "./context-types.js";
import { compareText, uniqueSorted } from "./context-serialization.js";

export const CONTEXT_REASONER_DECISIONS = ["include", "exclude", "unresolved"] as const satisfies readonly ContextDecision[];
export const CONTEXT_REASONER_RELEVANCE = ["direct", "supporting", "weak", "none"] as const satisfies readonly ContextRelevance[];
export const CONTEXT_REASONER_REASON_CODES = [
  "PINNED_CONTEXT",
  "UNRESOLVED_COMPARABLE_CONFLICT",
  "CONFLICT_LOWER_SUPPORT",
  "DIRECT_TASK_RELEVANCE",
  "SUPPORTING_TASK_RELEVANCE",
  "NO_TASK_RELEVANCE",
  "SEMANTIC_DUPLICATE"
] as const;
export const CONTEXT_REASONER_EXPLANATIONS = [
  "A linked candidate states the same rule without an evidence-provenance boilerplate suffix.",
  "Deterministic task, protection, validation, or safety evidence pins this context.",
  "Conflicting candidates have comparable task relevance, confidence, and overlapping scope.",
  "A conflicting candidate has stronger task relevance or repository confidence.",
  "The candidate has a direct lexical, path, or deterministic task match.",
  "A bounded deterministic relationship makes the candidate supporting task context.",
  "A single weak lexical overlap is insufficient to promote this context.",
  "The candidate has no lexical, path, scope, or bounded relationship to the task.",
  "Direct task evidence."
] as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownKeys(value: UnknownRecord, allowed: readonly string[], location: string, errors: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(`${location}.${key}: unexpected field`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) errors.push(`${location}.${key}: required field missing`);
  }
}

function stringArray(value: unknown, location: string, errors: string[], requireOne = false): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${location}: expected an array of strings`);
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim() === "") {
      errors.push(`${location}[${index}]: expected a non-empty string`);
      continue;
    }
    if (seen.has(item)) errors.push(`${location}[${index}]: duplicate value '${item}'`);
    else {
      seen.add(item);
      result.push(item);
    }
  }
  if (requireOne && result.length === 0) errors.push(`${location}: must contain at least one value`);
  return result;
}

function invalidReasoner(errors: readonly string[]): never {
  const stableErrors = uniqueSorted(errors);
  throw new ContextCompilationError(
    `Invalid context reasoner response: ${stableErrors.join("; ")}`,
    "CONTEXT_REASONER_INVALID",
    "reason-context",
    { errors: stableErrors }
  );
}

function allowedReasonCode(code: string, candidate: ContextReasoningRequest["candidates"][number] | undefined): boolean {
  if ((CONTEXT_REASONER_REASON_CODES as readonly string[]).includes(code)) return true;
  const match = code.match(/^SEMANTIC_DUPLICATE_OF:(\S+)$/u);
  return match?.[1] !== undefined && candidate?.conflictingCandidateIds.includes(match[1]) === true;
}

/**
 * Strictly validates the provider-neutral response. Besides schema checks, this
 * prevents the reasoner from inventing candidates, evidence, or conflict edges.
 */
export function validateReasoningResponse(
  request: ContextReasoningRequest,
  response: unknown
): ContextReasoningResponse {
  const errors: string[] = [];
  const candidateById = new Map<string, ContextReasoningRequest["candidates"][number]>();
  for (const [index, candidate] of request.candidates.entries()) {
    if (candidateById.has(candidate.candidateId)) {
      errors.push(`request.candidates[${index}].candidateId: duplicate candidate '${candidate.candidateId}'`);
    } else candidateById.set(candidate.candidateId, candidate);
  }
  for (const [index, candidate] of request.candidates.entries()) {
    const allowedConflicts = new Set(candidate.conflictingCandidateIds);
    for (const conflictId of allowedConflicts) {
      if (conflictId === candidate.candidateId) {
        errors.push(`request.candidates[${index}].conflictingCandidateIds: candidate cannot conflict with itself`);
      } else if (!candidateById.has(conflictId)) {
        errors.push(`request.candidates[${index}].conflictingCandidateIds: unknown candidate '${conflictId}'`);
      }
    }
  }

  const allowedDecisions = new Set<ContextDecision>();
  for (const decision of request.allowedDecisions) {
    if (!CONTEXT_REASONER_DECISIONS.includes(decision)) errors.push(`request.allowedDecisions: invalid decision '${decision}'`);
    else allowedDecisions.add(decision);
  }
  const allowedRelevance = new Set<ContextRelevance>();
  for (const relevance of request.allowedRelevance) {
    if (!CONTEXT_REASONER_RELEVANCE.includes(relevance)) errors.push(`request.allowedRelevance: invalid relevance '${relevance}'`);
    else allowedRelevance.add(relevance);
  }

  if (!isRecord(response)) invalidReasoner([...errors, "response: expected an object"]);
  ownKeys(response, ["decisions"], "response", errors);
  if (!Array.isArray(response.decisions)) invalidReasoner([...errors, "response.decisions: expected an array"]);

  const output: ContextReasoningDecision[] = [];
  const seenCandidateIds = new Set<string>();
  const fields = [
    "candidateId",
    "relevance",
    "proposedDecision",
    "reasonCodes",
    "explanation",
    "conflictingCandidateIds",
    "evidenceIds"
  ] as const;

  for (const [index, rawDecision] of response.decisions.entries()) {
    const location = `response.decisions[${index}]`;
    if (!isRecord(rawDecision)) {
      errors.push(`${location}: expected an object`);
      continue;
    }
    ownKeys(rawDecision, fields, location, errors);
    const candidateId = typeof rawDecision.candidateId === "string" ? rawDecision.candidateId : "";
    if (candidateId.trim() === "") errors.push(`${location}.candidateId: expected a non-empty string`);
    else if (seenCandidateIds.has(candidateId)) errors.push(`${location}.candidateId: duplicate decision for '${candidateId}'`);
    else seenCandidateIds.add(candidateId);
    const candidate = candidateById.get(candidateId);
    if (candidateId !== "" && candidate === undefined) errors.push(`${location}.candidateId: unknown candidate '${candidateId}'`);

    const relevance = rawDecision.relevance;
    if (typeof relevance !== "string" || !CONTEXT_REASONER_RELEVANCE.includes(relevance as ContextRelevance) || !allowedRelevance.has(relevance as ContextRelevance)) {
      errors.push(`${location}.relevance: invalid or disallowed relevance '${String(relevance)}'`);
    }
    const proposedDecision = rawDecision.proposedDecision;
    if (typeof proposedDecision !== "string" || !CONTEXT_REASONER_DECISIONS.includes(proposedDecision as ContextDecision) || !allowedDecisions.has(proposedDecision as ContextDecision)) {
      errors.push(`${location}.proposedDecision: invalid or disallowed decision '${String(proposedDecision)}'`);
    }
    const reasonCodes = stringArray(rawDecision.reasonCodes, `${location}.reasonCodes`, errors, true);
    for (const reasonCode of reasonCodes) {
      if (!/^[A-Z][A-Z0-9_]*(?::[A-Za-z0-9_.-]+)?$/.test(reasonCode) || reasonCode.length > 200) {
        errors.push(`${location}.reasonCodes: invalid machine-readable reason code '${reasonCode}'`);
      } else if (!allowedReasonCode(reasonCode, candidate)) {
        errors.push(`${location}.reasonCodes: unsupported or ungrounded reason code '${reasonCode}'`);
      }
    }
    const conflictingCandidateIds = stringArray(rawDecision.conflictingCandidateIds, `${location}.conflictingCandidateIds`, errors);
    const evidenceIds = stringArray(rawDecision.evidenceIds, `${location}.evidenceIds`, errors, true);

    const explanation = rawDecision.explanation;
    if (typeof explanation !== "string" || explanation.trim() === "") {
      errors.push(`${location}.explanation: expected a non-empty string`);
    } else if (Array.from(explanation).length > 1_000) {
      errors.push(`${location}.explanation: exceeds 1000 characters`);
    } else if (!(CONTEXT_REASONER_EXPLANATIONS as readonly string[]).includes(explanation.trim())) {
      errors.push(`${location}.explanation: unsupported free-form claim`);
    }

    if (candidate !== undefined) {
      const allowedConflictIds = new Set(candidate.conflictingCandidateIds);
      for (const conflictId of conflictingCandidateIds) {
        if (conflictId === candidateId) errors.push(`${location}.conflictingCandidateIds: candidate cannot conflict with itself`);
        else if (!candidateById.has(conflictId)) errors.push(`${location}.conflictingCandidateIds: unknown candidate '${conflictId}'`);
        else if (!allowedConflictIds.has(conflictId)) errors.push(`${location}.conflictingCandidateIds: invented conflict '${conflictId}'`);
      }
      const allowedEvidenceIds = new Set(candidate.evidenceIds);
      for (const evidenceId of evidenceIds) {
        if (!allowedEvidenceIds.has(evidenceId)) errors.push(`${location}.evidenceIds: invented evidence '${evidenceId}'`);
      }
    }

    if (
      candidate !== undefined &&
      typeof relevance === "string" && CONTEXT_REASONER_RELEVANCE.includes(relevance as ContextRelevance) && allowedRelevance.has(relevance as ContextRelevance) &&
      typeof proposedDecision === "string" && CONTEXT_REASONER_DECISIONS.includes(proposedDecision as ContextDecision) && allowedDecisions.has(proposedDecision as ContextDecision) &&
      typeof explanation === "string" && explanation.trim() !== ""
    ) {
      output.push({
        candidateId,
        relevance: relevance as ContextRelevance,
        proposedDecision: proposedDecision as ContextDecision,
        reasonCodes: uniqueSorted(reasonCodes),
        explanation: explanation.trim(),
        conflictingCandidateIds: uniqueSorted(conflictingCandidateIds),
        evidenceIds: uniqueSorted(evidenceIds)
      });
    }
  }

  for (const candidateId of candidateById.keys()) {
    if (!seenCandidateIds.has(candidateId)) errors.push(`response.decisions: missing decision for '${candidateId}'`);
  }
  if (response.decisions.length !== request.candidates.length) {
    errors.push(`response.decisions: expected ${request.candidates.length} decisions, received ${response.decisions.length}`);
  }
  if (errors.length > 0) invalidReasoner(errors);
  return { decisions: output.sort((left, right) => compareText(left.candidateId, right.candidateId)) };
}
