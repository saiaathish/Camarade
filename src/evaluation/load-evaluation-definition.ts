import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, dirname } from "node:path";
import { EvaluationDefinitionError } from "./evaluation-errors.js";
import { validateEvaluationDefinition, type EvaluationDefinition } from "./evaluation-definition-schema.js";
export interface LoadedEvaluationDefinition { definitionPath: string; definitionDirectory: string; definition: EvaluationDefinition; }
const MAX = 1048576;
export async function loadEvaluationDefinition(definitionPath: string): Promise<LoadedEvaluationDefinition> {
  if (typeof definitionPath !== "string" || definitionPath.trim() === "" || !isAbsolute(definitionPath) || definitionPath.includes("\0")) throw new EvaluationDefinitionError("Definition path must be a nonblank absolute path without null bytes.", "INVALID_PATH", definitionPath);
  let info; try { info = await lstat(definitionPath); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new EvaluationDefinitionError("Evaluation definition was not found.", "NOT_FOUND", definitionPath, undefined, cause); throw new EvaluationDefinitionError("Evaluation definition could not be inspected.", "READ_FAILED", definitionPath, undefined, cause); }
  if (info.isSymbolicLink()) throw new EvaluationDefinitionError("Symbolic-link evaluation definitions are not allowed.", "SYMLINK_NOT_ALLOWED", definitionPath);
  if (!info.isFile()) throw new EvaluationDefinitionError("Evaluation definition must be a regular file.", "NOT_REGULAR_FILE", definitionPath);
  if (info.size > MAX) throw new EvaluationDefinitionError("Evaluation definition exceeds the 1 MiB limit.", "FILE_TOO_LARGE", definitionPath);
  let text; try { text = await readFile(definitionPath, "utf8"); } catch (cause) { throw new EvaluationDefinitionError("Evaluation definition could not be read.", "READ_FAILED", definitionPath, undefined, cause); }
  let raw: unknown; try { raw = JSON.parse(text); } catch (cause) { throw new EvaluationDefinitionError("Evaluation definition is not valid JSON.", "INVALID_JSON", definitionPath, undefined, cause); }
  try { return { definitionPath, definitionDirectory: dirname(definitionPath), definition: validateEvaluationDefinition(raw) }; } catch (cause) { if (cause instanceof EvaluationDefinitionError) { throw new EvaluationDefinitionError(cause.message, cause.code, definitionPath, cause.issues, cause); } throw cause; }
}
