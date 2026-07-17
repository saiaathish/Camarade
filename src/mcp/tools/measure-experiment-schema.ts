import { z } from "zod/v3";
import { EVALUATION_EXECUTION_CONFIRMATION } from "../../evaluation/measure-experiment.js";

const absolutePath = z.string().trim().min(1).refine((value) => value.startsWith("/"), "Path must be absolute").refine((value) => !value.includes("\0"), "Path must not contain null bytes");

export const measureExperimentSchema = z.object({
  comparison_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  evaluation_definition_path: absolutePath,
  experiment_directory: absolutePath.optional(),
  controller_root: absolutePath.optional(),
  execution_confirmation: z.object({
    confirmed: z.literal(true),
    statement: z.literal(EVALUATION_EXECUTION_CONFIRMATION)
  }).strict()
}).strict();

export type MeasureExperimentMcpInput = z.infer<typeof measureExperimentSchema>;
