import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { timeoutSecondsToMilliseconds } from "../core/process-timeout.js";
import { terminateProcessTree } from "../core/terminate-process-tree.js";
import type { CodexTerminationReason, ConditionRuntimeLayout, ResolvedCodexRuntime, ExperimentConditionId } from "../experiment/experiment-types.js";
export interface CodexAdapterInput { conditionId: ExperimentConditionId; worktreePath: string; prompt: string; runtime: ConditionRuntimeLayout; codex: ResolvedCodexRuntime; environment: NodeJS.ProcessEnv; }
export interface CodexProcessResult { startedAt:string; completedAt:string; durationMs:number; exitCode:number|null; timedOut:boolean; terminationReason:CodexTerminationReason; }
export async function runCodex(input: CodexAdapterInput): Promise<CodexProcessResult> {
  const started = Date.now(); const stdout = await open(input.runtime.stdoutPath, "wx"); const stderr = await open(input.runtime.stderrPath, "wx"); let timedOut=false; let reason:CodexTerminationReason="exit";
  const args=[...input.codex.configuredArguments,...input.codex.fixedArguments,"--cd",input.worktreePath,"--color","never","--json","--output-last-message",input.runtime.finalMessagePath,"--ephemeral","--ignore-user-config","--ignore-rules","-"];
  const child=spawn(input.codex.resolvedExecutable,args,{cwd:input.worktreePath,env:input.environment,shell:false,stdio:["pipe",stdout.fd,stderr.fd],detached:process.platform!=="win32"});
  const timer=setTimeout(()=>{timedOut=true;reason="timeout";terminateProcessTree(child,"SIGTERM");},timeoutSecondsToMilliseconds(input.codex.timeoutSeconds,"Codex timeout"));
  if (child.stdin===null) { reason="stdin-error"; clearTimeout(timer); await stdout.close(); await stderr.close(); throw new Error("Codex stdin unavailable"); }
  child.stdin.write(input.prompt); child.stdin.end();
  const exitCode=await new Promise<number|null>((resolve,reject)=>{child.once("error",error=>{reason="spawn-error";reject(error);});child.once("close",code=>resolve(code));}); clearTimeout(timer); await stdout.close(); await stderr.close(); const completed=Date.now(); return {startedAt:new Date(started).toISOString(),completedAt:new Date(completed).toISOString(),durationMs:completed-started,exitCode:timedOut?null:exitCode,timedOut,terminationReason:reason};
}
