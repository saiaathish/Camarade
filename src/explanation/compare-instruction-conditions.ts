import { identityOf, normalized, obj, records, type Obj } from "./instruction-impact-match.js";
export interface ConditionView { membership: "baseline"|"optimized"|"both"|"neither"; baseline: Obj[]; optimized: Obj[]; }
export const compareInstructionConditions = (id: string, baseline: unknown, optimized: unknown, instruction: Obj): ConditionView => {
  const inSet = (v: unknown) => records(v, ["instructions", "instructionSet", "instructionRecords", "context", "manifest"]).filter(x => (identityOf(x) && normalized(identityOf(x)) === normalized(identityOf(instruction))) || String(x.instructionId ?? "") === id);
  const b = inSet(baseline), o = inSet(optimized); return { membership: b.length && o.length ? "both" : o.length ? "optimized" : b.length ? "baseline" : "neither", baseline: b, optimized: o };
};
