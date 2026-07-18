import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDashboardServer } from "../src/dashboard-server/index.js";
import { DashboardRunSchema } from "../src/dashboard/contract.js";
const get=(port:number,path:string)=>new Promise<{status:number;body:string}>((resolve,reject)=>import("node:http").then(({get})=>{const r=get({host:"127.0.0.1",port,path},x=>{let b="";x.on("data",c=>b+=c);x.on("end",()=>resolve({status:x.statusCode??0,body:b}));});r.on("error",reject);}));
describe("S8-04 deterministic certification",()=>{
  it("[S8I21] serves deterministic persisted certification run and frontend route",async()=>{const root=await mkdtemp(join(tmpdir(),"s8i21-"));try{const run=JSON.parse(await readFile(join(process.cwd(),"fixtures/stage-8/dashboard/valid-camarade-win.json"),"utf8"));run.comparisonId="cert";run.simulation=true;run.realModel=false;run.network=false;DashboardRunSchema.parse(run);await mkdir(join(root,".camarade/runs/cert"),{recursive:true});await writeFile(join(root,".camarade/runs/cert/dashboard-run.json"),JSON.stringify(run));const s=await startDashboardServer({controllerRoot:root,port:0});try{expect((await get(s.port,"/api/runs")).status).toBe(200);const d=await get(s.port,"/api/runs/cert");expect(d.body).toContain('"outcome":"win"');expect(d.body).toContain("helped");expect((await get(s.port,"/runs/cert/")).status).toBe(200);expect((await get(s.port,"/assets/main-DmRmlNoY.js")).status).toBe(200);expect(d.body).not.toMatch(/\/Users\/|\/private\//);}finally{await s.close();await s.closed;}}finally{await rm(root,{recursive:true,force:true});}});
  it("[S8I22] leaves no server resources after shutdown",async()=>{const s=await startDashboardServer({port:0});const p=s.port;await s.close();await s.closed;await expect(get(p,"/api/health")).rejects.toThrow();});
});
