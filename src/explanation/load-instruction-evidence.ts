import { lstat, readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { TextDecoder } from "node:util";
import { validateInstructionEvidence } from "./instruction-evidence-schema.js";
import { InstructionEvidenceError } from "./instruction-evidence-errors.js";
import type { InstructionEvidenceRecord } from "./instruction-evidence-types.js";
export async function loadInstructionEvidence(repositoryRoot: string, reference: string, maxBytes = 1024 * 1024): Promise<InstructionEvidenceRecord> {
  if (!reference || reference.includes("\0") || reference.includes("\\") || isAbsolute(reference) || reference.split("/").includes("..")) throw new InstructionEvidenceError("Unsafe instruction evidence path.", "INVALID_PATH");
  const root = resolve(repositoryRoot); const path = resolve(root, reference); const rel = relative(root, path); if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new InstructionEvidenceError("Instruction evidence path escapes repository.", "INVALID_PATH");
  let stat; try { stat = await lstat(path); } catch (cause) { throw new InstructionEvidenceError("Instruction evidence file was not found.", "NOT_FOUND", undefined, cause); }
  if (stat.isSymbolicLink()) throw new InstructionEvidenceError("Instruction evidence symlinks are not allowed.", "UNSAFE_SYMLINK");
  if (!stat.isFile()) throw new InstructionEvidenceError("Instruction evidence path is not a regular file.", "NOT_REGULAR_FILE");
  if (stat.size > maxBytes) throw new InstructionEvidenceError("Instruction evidence file is too large.", "FILE_TOO_LARGE");
  let bytes: Buffer; try { bytes = await readFile(path); } catch (cause) { throw new InstructionEvidenceError("Instruction evidence could not be read.", "NOT_FOUND", undefined, cause); }
  let json: unknown; try { const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); json = JSON.parse(raw); } catch (cause) { throw new InstructionEvidenceError("Instruction evidence is not valid UTF-8 JSON.", "INVALID_UTF8", undefined, cause); }
  return validateInstructionEvidence(json);
}
