import { linkedIds, records, sourceRef, text, type Obj } from "./instruction-impact-match.js";
export const matchInstructionChanges = (id: string, value: unknown): Obj[] => records(value, ["changedFiles", "changes", "changeEvidence", "changedFileEvidence"]).filter(x => linkedIds(x).includes(id) && (text(x.path) || text(x.relativePath) || text(x.file))).filter(x => sourceRef(x));
