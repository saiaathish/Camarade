import { linkedIds, records, sourceRef, text, type Obj } from "./instruction-impact-match.js";
export const matchInstructionDependencies = (id: string, value: unknown): Obj[] => records(value, ["dependencyDeltas", "dependencies", "dependencyEvidence"]).filter(x => linkedIds(x).includes(id) && (text(x.name) || text(x.package) || text(x.dependency))).filter(x => sourceRef(x));
