import { linkedIds, records, sourceRef, type Obj } from "./instruction-impact-match.js";
export const matchInstructionChecks = (id: string, value: unknown): Obj[] => records(value, ["requirements", "requirementResults", "checks", "checkResults", "rules", "ruleResults", "materialRuleViolations"]).filter(x => linkedIds(x).includes(id)).filter(x => sourceRef(x));
