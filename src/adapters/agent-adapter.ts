import type { AgentRunResult, RunCondition } from "../core/types.js";

export interface AgentRunInput {
  worktreePath: string;
  task: string;
  condition: RunCondition;
  contextPackPath?: string;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs: number;
}

export interface AgentAdapter {
  readonly id: string;
  execute(input: AgentRunInput): Promise<AgentRunResult>;
}
