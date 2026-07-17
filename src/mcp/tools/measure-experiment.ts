import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { failureResult } from "../mcp-errors.js";
import { measureCompletedExperiment, type MeasureCompletedRequest, type MeasureExperimentMcpResult } from "../../evaluation/measure-completed-experiment.js";
import { measureExperimentSchema, type MeasureExperimentMcpInput } from "./measure-experiment-schema.js";
export type MeasureExperimentService=(request:MeasureCompletedRequest)=>Promise<MeasureExperimentMcpResult>;
export async function handleMeasureExperiment(input:unknown,service:MeasureExperimentService=measureCompletedExperiment):Promise<CallToolResult>{
 const parsed=measureExperimentSchema.safeParse(input); if(!parsed.success)return failureResult({status:"failed",code:"STAGE6_REQUEST_INVALID",stage:"request-validation",message:"Invalid measurement request.",evidence_path:null});
 const p=parsed.data; try { const result=await service({comparisonId:p.comparison_id,controllerRoot:p.controller_root,experimentDirectory:p.experiment_directory}); return {content:[{type:"text",text:JSON.stringify(result)}],structuredContent:result}; } catch(e) { const code=e instanceof Error&&/^STAGE6_/.test(e.message)?e.message:"STAGE6_ARTIFACT_VALIDATION_FAILED"; return failureResult({status:"failed",code,stage:"stage6",message:"Stage 6 measurement failed.",evidence_path:null}); }
}
