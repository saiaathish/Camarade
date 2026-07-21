import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import path from "node:path";
import { tmpdir } from "node:os";
import * as net from "node:net";
import { installedCamaradeInvocation, npmInvocation, requirePortableSuccess, terminatePortableProcess } from "../scripts/lib/portable-command.js";
const root=process.cwd();
const npm=(args:readonly string[],cwd=root,timeoutMs=120_000)=>requirePortableSuccess({...npmInvocation(args),cwd,timeoutMs});
const request=(port:number,path:string)=>new Promise<{status:number;body:string}>((resolve,reject)=>import("node:http").then(({get})=>{const req=get({host:"127.0.0.1",port,path},res=>{let body="";res.on("data",x=>body+=x);res.on("end",()=>resolve({status:res.statusCode??0,body}));});req.on("error",reject);}));
const scriptPath=(html:string)=>html.match(/<script[^>]+src="([^"]+\.js)"/u)?.[1];
const freePort=async()=>await new Promise<number>((resolve,reject)=>{const s=net.createServer();s.once("error",reject);s.listen(0,"127.0.0.1",()=>{const p=(s.address() as net.AddressInfo).port;s.close(()=>resolve(p));});});
describe("S8-04 package", () => {
  it("[S8I17] copies built frontend", async () => expect((await readFile(join(root,"dist/frontend/index.html"),"utf8")).length).toBeGreaterThan(20));
  it("[S8I18] packages frontend assets", async () => { const x=JSON.parse((await npm(["pack","--dry-run","--json"])).stdout)[0].files.map((f:{path:string})=>f.path); expect(x).toContain("dist/frontend/index.html"); });
  it("[S8I19] excludes frontend source", async () => { const x=JSON.parse((await npm(["pack","--dry-run","--json"])).stdout)[0].files.map((f:{path:string})=>f.path); expect(x.some((p:string)=>p.startsWith("frontend/src/"))).toBe(false); });
  it("[S8I20] tarball dashboard smoke serves routes and exits on SIGTERM", async () => {
    const temp=await mkdtemp(join(tmpdir(),"s8i20-")); let tgz=""; let child:ReturnType<typeof spawn>|undefined;
    try {
      tgz=(await npm(["pack","--silent"])).stdout.trim().split(/\r?\n/u).at(-1)??""; expect(tgz).toMatch(/\.tgz$/);
      const controller=join(temp,"controller"); await mkdir(join(controller,".camarade/runs/win-001"),{recursive:true});
      await writeFile(join(controller,".camarade/runs/win-001/dashboard-run.json"),await readFile(join(root,"fixtures/stage-8/dashboard/valid-camarade-win.json")));
      const port=await freePort(); const packagePath=join(root,tgz); await npm(["install","--offline=false","--prefer-online","--ignore-scripts","--no-save","--prefix",temp,packagePath],temp); const logChunks:string[]=[];
      const invocation=await installedCamaradeInvocation(temp,["dashboard","win-001","--controller-root",controller,"--port",String(port),"--no-open"]);
      const installedEntry=resolve(invocation.args[0]??"");
      await access(installedEntry);
      expect(invocation.command).toBe(process.execPath);
      expect(relative(temp,installedEntry)).not.toMatch(/^\.\.(?:[/\\]|$)/u);
      const fromRepository = relative(root,installedEntry);
      expect(path.isAbsolute(fromRepository) || /^\.\.(?:[/\\]|$)/u.test(fromRepository)).toBe(true);
      child=spawn(invocation.command,invocation.args,{cwd:temp,env:{...process.env,CI:"1"},detached:process.platform!=="win32",windowsHide:true,stdio:["ignore","pipe","pipe"]});
      child.stdout!.on("data",x=>logChunks.push(String(x))); child.stderr!.on("data",x=>logChunks.push(String(x)));
      await new Promise<void>((resolve,reject)=>{const deadline=Date.now()+15000; const poll=()=>{if(logChunks.join("").includes(`http://127.0.0.1:${port}/runs/win-001/`))return resolve();if(child?.exitCode!==null)return reject(new Error(`tarball dashboard exited early: ${logChunks.join("")}`));if(Date.now()>deadline)return reject(new Error(`tarball dashboard did not start: ${logChunks.join("")}`));setTimeout(poll,50);};poll();});
      expect(logChunks.join("")).toContain(`Press Ctrl+C to stop.`);
      expect((await request(port,"/api/health")).status).toBe(200); expect((await request(port,"/api/runs")).body).toContain("win-001"); expect((await request(port,"/api/runs/win-001")).body).toContain('"outcome":"win"');
      expect((await request(port,"/runs/")).status).toBe(200); const shell=await request(port,"/runs/win-001/"); expect(shell.status).toBe(200); const asset=scriptPath(shell.body); expect(asset).toMatch(/^\/assets\/.+\.js$/u); expect((await request(port,asset!)).status).toBe(200);
      if(process.platform==="win32")terminatePortableProcess(child);else child.kill("SIGTERM");
      const exit=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{const timer=setTimeout(()=>{terminatePortableProcess(child!);reject(new Error(`tarball did not exit: ${logChunks.join("")}`));},10000);child!.once("exit",(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
      if(process.platform!=="win32")expect(exit.code).toBe(0);
      await expect(request(port,"/api/health")).rejects.toThrow();
    } finally { if(child && child.exitCode===null&&child.signalCode===null)terminatePortableProcess(child); await rm(temp,{recursive:true,force:true}); if(tgz)await rm(join(root,tgz),{force:true}); }
  },180000);
});
