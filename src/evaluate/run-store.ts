import { readdir, readFile, lstat, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { homedir } from "node:os";
import { DashboardRunListSchema, DashboardRunSchema, DashboardRunSummarySchema, type DashboardRun, type DashboardRunSummary } from "../dashboard/contract.js";
import { EvaluateTaskError } from "./errors.js";
function root(base?:string){return resolve(base??process.env.CAMARADE_HOME??resolve(homedir(),".camarade"), ".camarade", "runs")}
export async function listRuns(controllerRoot?:string):Promise<DashboardRunSummary[]> { const dir=root(controllerRoot); const names=await readdir(dir).catch(()=>[] as string[]);const values:DashboardRunSummary[]=[];for(const n of names){const p=resolve(dir,n,"dashboard-run.json");try{const x=DashboardRunSchema.parse(JSON.parse(await readFile(p,"utf8")));values.push(DashboardRunSummarySchema.parse({schemaVersion:x.schemaVersion,comparisonId:x.comparisonId,task:x.task,repository:x.repository,timestamps:x.timestamps,status:x.status,outcome:x.outcome,progress:x.progress}))}catch{ /* corrupt entries are ignored deterministically */ }}values.sort((a,b)=>String(b.timestamps.startedAt).localeCompare(String(a.timestamps.startedAt))||a.comparisonId.localeCompare(b.comparisonId));return DashboardRunListSchema.parse(values)}
export async function showRun(id:string,controllerRoot?:string):Promise<DashboardRun>{
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(id))throw new EvaluateTaskError("UNSAFE_COMPARISON_ID","Unsafe comparison ID.");
  const dir=root(controllerRoot), p=resolve(dir,id,"dashboard-run.json");
  const rel=relative(resolve(dir),p);if(rel.startsWith("..")||rel.includes("\\"))throw new EvaluateTaskError("UNSAFE_COMPARISON_ID","Unsafe comparison ID.");
  let current=resolve(dir);for(const part of [...rel.split("/"),].slice(0,-1)){current=resolve(current,part);const s=await lstat(current).catch(()=>undefined);if(!s||s.isSymbolicLink())throw new EvaluateTaskError("UNKNOWN_COMPARISON_ID","Unknown comparison ID.");}
  const s=await lstat(p).catch(()=>undefined);if(!s||s.isSymbolicLink())throw new EvaluateTaskError("UNKNOWN_COMPARISON_ID","Unknown comparison ID.");
  const actual=await realpath(p).catch(()=>{throw new EvaluateTaskError("UNKNOWN_COMPARISON_ID","Unknown comparison ID.")});
  const canonicalDir=await realpath(dir).catch(()=>resolve(dir));
  if(relative(canonicalDir,actual).startsWith(".."))throw new EvaluateTaskError("UNKNOWN_COMPARISON_ID","Run escapes canonical controller root.");
  try{return DashboardRunSchema.parse(JSON.parse(await readFile(actual,"utf8")))}catch{throw new EvaluateTaskError("INVALID_RUN","Persisted run is invalid.")}
}
