import { z } from "zod/v3";
import { isSafePortableAbsolutePath } from "../../core/path-portability.js";
export const EXPLAIN_CONFIRMATION = "I authorize Camarade to explain this completed experiment." as const;
const safeId = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "comparison_id is unsafe");
const safeAbsolute = z.string().min(1).refine(isSafePortableAbsolutePath, "path must be absolute and safe");
export const explainExperimentToolSchema = z.object({
  comparison_id: safeId.optional(), controller_root: safeAbsolute.optional(), experiment_directory: safeAbsolute.optional(),
  confirmation: z.object({ confirmed: z.literal(true), statement: z.literal(EXPLAIN_CONFIRMATION) }).strict()
}).strict();
export const explainExperimentInputSchema = explainExperimentToolSchema.superRefine((v, ctx) => {
  const comparison = v.comparison_id !== undefined || v.controller_root !== undefined;
  if (comparison !== (v.comparison_id !== undefined && v.controller_root !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "comparison_id requires controller_root" });
  if (comparison && v.experiment_directory !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "locator modes are mutually exclusive" });
  if (!comparison && v.experiment_directory === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "one locator mode is required" });
});
export type ExplainExperimentInput = z.infer<typeof explainExperimentInputSchema>;
