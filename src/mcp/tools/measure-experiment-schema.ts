import { z } from "zod/v3";
export const MEASURE_CONFIRMATION = "I authorize Camarade to measure this completed experiment." as const;
const safeId = z.string().min(1).refine(v=>v.trim()!==""&&!v.includes("/")&&!v.includes("\\")&&!v.includes("..")&&!v.includes("\0")&&!/^([A-Za-z]:|file:)/i.test(v),"comparison_id is unsafe");
const absPath = z.string().min(1).refine(v=>v.startsWith("/")&&!v.includes("\0")&&!v.split("/").includes(".."),"path must be absolute and safe");
export const measureExperimentInputSchema = z.object({
  comparison_id: safeId.optional(), controller_root: absPath.optional(), experiment_directory: absPath.optional(),
  confirmation: z.object({confirmed:z.literal(true),statement:z.literal(MEASURE_CONFIRMATION)}).strict(),
}).strict();
export const measureExperimentSchema = measureExperimentInputSchema.superRefine((v,ctx)=>{
  const byId=v.comparison_id!==undefined||v.controller_root!==undefined;
  const byDir=v.experiment_directory!==undefined;
  if(byId!== (v.comparison_id!==undefined&&v.controller_root!==undefined)) ctx.addIssue({code:z.ZodIssueCode.custom,message:"comparison_id requires controller_root"});
  if(byId&&byDir) ctx.addIssue({code:z.ZodIssueCode.custom,message:"locator modes are mutually exclusive"});
  if(!byId&&!byDir) ctx.addIssue({code:z.ZodIssueCode.custom,message:"one locator mode is required"});
});
export type MeasureExperimentMcpInput=z.infer<typeof measureExperimentSchema>;
