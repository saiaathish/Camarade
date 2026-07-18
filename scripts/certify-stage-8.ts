import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDashboardServer } from "../src/dashboard-server/index.js";
const root = await mkdtemp(join(tmpdir(), "camarade-s8-cert-"));
try { const run = join(root,".camarade/runs/demo"); await mkdir(run,{recursive:true}); const fixture = await import("../fixtures/stage-8/dashboard/valid-camarade-win.json",{with:{type:"json"}}); await writeFile(join(run,"dashboard-run.json"),JSON.stringify(fixture.default)); const server=await startDashboardServer({controllerRoot:root,port:0}); if(server.port<1) throw new Error("server did not bind"); await server.close(); await server.closed; console.log("Stage 8 certification: PASS"); console.log("This certification proves deterministic Stage 8 product integration only. It is not a real coding-agent benchmark or a model-quality claim."); } finally { await rm(root,{recursive:true,force:true}); }
