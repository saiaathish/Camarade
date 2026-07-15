import { z } from "zod/v3";
const text=(label:string)=>z.string().refine(v=>v.trim()!==`${""}`,`${label} must not be blank`).refine(v=>!v.includes("\0"),`${label} must not contain null bytes`);
export const runFairExperimentSchema=z.object({repository_root:text("repository_root"),task:text("task"),confirm_execution:z.literal(true),controller_root:text("controller_root").optional(),context_budget:z.number().int().safe().positive().optional(),experiment_id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional()}).strict();
export type RunFairExperimentMcpInput=z.infer<typeof runFairExperimentSchema>;
