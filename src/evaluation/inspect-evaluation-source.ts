import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { sha256, canonicalJson } from "../context/context-serialization.js";
import { normalizeTask } from "../context/normalize-task.js";
import { loadEvaluationDefinition } from "./load-evaluation-definition.js";
import type { PreparedEvaluationSealSource, EvaluationHiddenAssetSeal } from "./evaluation-seal-types.js";
import { EvaluationSealError } from "./evaluation-seal-errors.js";
import type { EvaluationDefinitionError } from "./evaluation-errors.js";
function inside(root:string,candidate:string):boolean { const r=relative(resolve(root),resolve(candidate)); return r!==".."&&!r.startsWith(`..${sep}`)&&!isAbsolute(r); }
function fail(message:string,code:EvaluationSealErrorCode,details:Record<string,unknown>={},cause?:unknown):never { throw new EvaluationSealError(message,code,"evaluation-inspection",details,undefined,cause); }
type EvaluationSealErrorCode=import("./evaluation-seal-errors.js").EvaluationSealErrorCode;
export interface InspectEvaluationSourceOptions { evaluationDefinitionPath?:string; experimentTask:string; repositoryPath:string; }
export async function inspectEvaluationSource(options:InspectEvaluationSourceOptions):Promise<PreparedEvaluationSealSource>{
 const experimentTaskHash=sha256(options.experimentTask); const normalizedExperiment=normalizeTask(options.experimentTask).normalizedTask; const normalizedTaskHash=sha256(normalizedExperiment);
 if(options.evaluationDefinitionPath===undefined) return {status:"unavailable",experimentTaskHash,normalizedTaskHash,hiddenAssets:[],hiddenAssetSources:new Map()};
 let loaded; try { loaded=await loadEvaluationDefinition(options.evaluationDefinitionPath); } catch(error) { const e=error as EvaluationDefinitionError; fail("Evaluation definition is invalid.","EVALUATION_DEFINITION_INVALID",{code:e.code},error); }
 let definitionReal:string; try { definitionReal=await realpath(options.evaluationDefinitionPath); } catch(cause){fail("Evaluation definition path cannot be resolved.","EVALUATION_SOURCE_UNSAFE",{},cause);}
 const defDir=await realpath(dirname(definitionReal)); const repo=await realpath(options.repositoryPath); if(!isAbsolute(options.evaluationDefinitionPath)) fail("Evaluation definition path must be absolute.","EVALUATION_SOURCE_UNSAFE");
 const definitionTask=normalizeTask(loaded.definition.task).normalizedTask; const evaluationTaskHash=sha256(loaded.definition.task); const normalizedDefinitionHash=sha256(definitionTask);
 if(definitionTask!==normalizedExperiment) fail("Evaluation task does not match experiment task.","EVALUATION_TASK_MISMATCH",{experimentTaskHash,evaluationTaskHash,experimentNormalizedTaskHash:normalizedTaskHash,evaluationNormalizedTaskHash:normalizedDefinitionHash});
 const definitionHash=sha256(canonicalJson(loaded.definition)); const hiddenAssets:EvaluationHiddenAssetSeal[]=[]; const sources=new Map<string,string>();
 for(const relativePath of loaded.definition.hiddenAssets){ const candidate=resolve(defDir,relativePath); if(!inside(defDir,candidate)) fail("Hidden asset escapes definition directory.","EVALUATION_HIDDEN_ASSET_UNSAFE",{relativePath}); let current=defDir; for(const part of relative(defDir,candidate).split(sep)){current=resolve(current,part);const st=await lstat(current).catch(()=>undefined);if(st?.isSymbolicLink()) fail("Hidden asset path contains a symbolic link.","EVALUATION_HIDDEN_ASSET_UNSAFE",{relativePath});} const st=await lstat(candidate).catch(()=>undefined); if(!st) fail("Hidden asset was not found.","EVALUATION_HIDDEN_ASSET_NOT_FOUND",{relativePath}); if(st.isSymbolicLink()) fail("Hidden asset symbolic links are forbidden.","EVALUATION_HIDDEN_ASSET_UNSAFE",{relativePath}); if(!st.isFile()) fail("Hidden asset must be a regular file.","EVALUATION_HIDDEN_ASSET_NOT_REGULAR_FILE",{relativePath}); const real=await realpath(candidate); if(inside(repo,real)) fail("Hidden assets must remain outside the target repository.","EVALUATION_HIDDEN_ASSET_UNSAFE",{relativePath}); const bytes=await readFile(candidate); hiddenAssets.push({relativePath,artifactRelativePath:`evaluation/hidden-assets/${relativePath.replaceAll(sep,"/")}`,sha256:sha256(bytes),byteLength:bytes.byteLength}); sources.set(relativePath,candidate); }
 hiddenAssets.sort((a,b)=>a.relativePath.localeCompare(b.relativePath)); return {status:"sealed",evaluationDefinitionPath:options.evaluationDefinitionPath,sourceDefinitionPath:definitionReal,definition:loaded.definition,definitionHash,evaluationTaskHash,experimentTaskHash,normalizedTaskHash,hiddenAssets,hiddenAssetSources:sources};
}
