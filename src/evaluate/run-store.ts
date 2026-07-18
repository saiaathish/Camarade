import { readdir, readFile, lstat, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { homedir } from "node:os";
import { DashboardRunListSchema, DashboardRunSchema, DashboardRunSummarySchema, type DashboardRun, type DashboardRunSummary } from "../dashboard/contract.js";
import { EvaluateTaskError } from "./errors.js";
export const MAX_DASHBOARD_RUN_BYTES=2097152;
function root(base?:string){return resolve(base??process.env.CAMARADE_HOME??resolve(homedir(),".camarade"),".camarade","runs")}
export class SafeDashboardRunRepository {
  readonly runsRoot:string; constructor(controllerRoot?:string){this.runsRoot=root(controllerRoot)}
  async listRuns(onCorrupt?:(entry:string)=>void):Promise<DashboardRunSummary[]>{const names=await readdir(this.runsRoot).catch(()=>[] as string[]);const out:DashboardRunSummary[]=[];for(const n of names){try{const e=resolve(this.runsRoot,n),p=resolve(e,"dashboard-run.json"),d=await lstat(e),f=await lstat(p);if(!d.isDirectory()||d.isSymbolicLink()||!f.isFile()||f.isSymbolicLink()||f.size>MAX_DASHBOARD_RUN_BYTES)throw Error();const x=DashboardRunSchema.parse(JSON.parse(await readFile(p,"utf8")));out.push(DashboardRunSummarySchema.parse({schemaVersion:x.schemaVersion,comparisonId:x.comparisonId,task:x.task,repository:x.repository,timestamps:x.timestamps,status:x.status,outcome:x.outcome,progress:x.progress}))}catch{onCorrupt?.(n)}}out.sort((a,b)=>String(b.timestamps.startedAt).localeCompare(String(a.timestamps.startedAt))||a.comparisonId.localeCompare(b.comparisonId));return DashboardRunListSchema.parse(out)}
  getRun(id:string){return showRunFromRoot(id,this.runsRoot)}
}
export const createSafeDashboardRunRepository=(controllerRoot?:string)=>new SafeDashboardRunRepository(controllerRoot);
export const listRuns=(controllerRoot?:string,onCorrupt?:(entry:string)=>void)=>new SafeDashboardRunRepository(controllerRoot).listRuns(onCorrupt);
export const showRun=(id:string,controllerRoot?:string)=>showRunFromRoot(id,root(controllerRoot));
async function showRunFromRoot(id:string,dir:string):Promise<DashboardRun>{if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(id))throw new EvaluateTaskError("UNSAFE_COMPARISON_ID","Unsafe comparison ID.");const p=resolve(dir,id,"dashboard-run.json");const rel=relative(dir,p);if(rel.startsWith("..")||rel.includes("\\"))throw new EvaluateTaskError("UNSAFE_COMPARISON_ID","Unsafe comparison ID.");const d=await lstat(resolve(dir,id)).catch(()=>undefined),s=await lstat(p).catch(()=>undefined);if(!d||!d.isDirectory()||d.isSymbolicLink()||!s||!s.isFile()||s.isSymbolicLink())throw new EvaluateTaskError("UNKNOWN_COMPARISON_ID","Unknown comparison ID.");const actual=await realpath(p).catch(()=>{throw new EvaluateTaskError("UNKNOWN_COMPARISON_ID","Unknown comparison ID.")});if(relative(await realpath(dir).catch(()=>dir),actual).startsWith(".."))throw new EvaluateTaskError("UNKNOWN_COMPARISON_ID","Run escapes canonical controller root.");try{const f=await lstat(actual);if(f.size>MAX_DASHBOARD_RUN_BYTES)throw Error();return DashboardRunSchema.parse(JSON.parse(await readFile(actual,"utf8")))}catch{throw new EvaluateTaskError("INVALID_RUN","Persisted run is invalid.")}}
