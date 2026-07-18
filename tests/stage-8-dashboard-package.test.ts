import { describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as net from "node:net";
const exec=promisify(execFile); const root=process.cwd();
const request=(port:number,path:string)=>new Promise<{status:number;body:string}>((resolve,reject)=>import("node:http").then(({get})=>{const req=get({host:"127.0.0.1",port,path},res=>{let body="";res.on("data",x=>body+=x);res.on("end",()=>resolve({status:res.statusCode??0,body}));});req.on("error",reject);}));
const freePort=async()=>await new Promise<number>((resolve,reject)=>{const s=net.createServer();s.once("error",reject);s.listen(0,"127.0.0.1",()=>{const p=(s.address() as net.AddressInfo).port;s.close(()=>resolve(p));});});
describe("S8-04 package", () => {
  it("[S8I17] copies built frontend", async () => expect((await readFile(join(root,"dist/frontend/index.html"),"utf8")).length).toBeGreaterThan(20));
  it("[S8I18] packages frontend assets", async () => { const x=JSON.parse((await exec("npm",["pack","--dry-run","--json"],{cwd:root})).stdout)[0].files.map((f:{path:string})=>f.path); expect(x).toContain("dist/frontend/index.html"); });
  it("[S8I19] excludes frontend source", async () => { const x=JSON.parse((await exec("npm",["pack","--dry-run","--json"],{cwd:root})).stdout)[0].files.map((f:{path:string})=>f.path); expect(x.some((p:string)=>p.startsWith("frontend/src/"))).toBe(false); });
  it("[S8I20] tarball dashboard smoke serves routes and exits on SIGTERM", async () => {
    const temp=await mkdtemp(join(tmpdir(),"s8i20-")); let tgz=""; let child:ReturnType<typeof spawn>|undefined;
    try {
      tgz=(await exec("npm",["pack","--silent"],{cwd:root})).stdout.trim(); expect(tgz).toMatch(/\.tgz$/);
      const controller=join(temp,"controller"); await mkdir(join(controller,".camarade/runs/win-001"),{recursive:true});
      await writeFile(join(controller,".camarade/runs/win-001/dashboard-run.json"),await readFile(join(root,"fixtures/stage-8/dashboard/valid-camarade-win.json")));
      const port=await freePort(); const packagePath=join(root,tgz); await exec("npm",["install","--offline","--ignore-scripts","--no-save","--prefix",temp,packagePath],{cwd:temp,timeout:20000}); const logChunks:string[]=[];
      child=spawn(join(temp,"node_modules/.bin/camarade"),["dashboard","win-001","--controller-root",controller,"--port",String(port),"--no-open"],{cwd:temp,env:{...process.env,CI:"1"},stdio:["ignore","pipe","pipe"]});
      child.stdout!.on("data",x=>logChunks.push(String(x))); child.stderr!.on("data",x=>logChunks.push(String(x)));
      await new Promise<void>((resolve,reject)=>{const deadline=Date.now()+15000; const poll=()=>{if(logChunks.join("").includes(`http://127.0.0.1:${port}/runs/win-001/`))return resolve();if(child?.exitCode!==null)return reject(new Error(`tarball dashboard exited early: ${logChunks.join("")}`));if(Date.now()>deadline)return reject(new Error(`tarball dashboard did not start: ${logChunks.join("")}`));setTimeout(poll,50);};poll();});
      expect(logChunks.join("")).toContain(`Press Ctrl+C to stop.`);
      expect((await request(port,"/api/health")).status).toBe(200); expect((await request(port,"/api/runs")).body).toContain("win-001"); expect((await request(port,"/api/runs/win-001")).body).toContain('"outcome":"win"');
      expect((await request(port,"/runs/")).status).toBe(200); expect((await request(port,"/runs/win-001/")).status).toBe(200); expect((await request(port,"/assets/main-DmRmlNoY.js")).status).toBe(200);
      child.kill("SIGTERM"); const exit=await new Promise<number>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`tarball did not exit: ${logChunks.join("")}`)),5000);child!.once("exit",code=>{clearTimeout(timer);resolve(code??-1);});}); expect(exit).toBe(0); await expect(request(port,"/api/health")).rejects.toThrow();
    } finally { if(child && child.exitCode===null){child.kill("SIGTERM"); await new Promise<void>(resolve=>child!.once("exit",()=>resolve()));} await rm(temp,{recursive:true,force:true}); if(tgz)await rm(join(root,tgz),{force:true}); }
  },30000);
});
