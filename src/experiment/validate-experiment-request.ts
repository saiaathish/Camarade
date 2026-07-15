import { isAbsolute } from "node:path";
import type { FairExperimentRequest, ValidatedFairExperimentRequest } from "./experiment-types.js";
import { ExperimentContractError } from "./experiment-errors.js";
import { normalizeTask } from "../context/normalize-task.js";
const allowed = new Set(["repositoryPath", "task", "controllerRoot", "contextBudget", "experimentId"]);
const fail = (message:string):never => { throw new ExperimentContractError(message,"EXPERIMENT_REQUEST_INVALID","request-validation"); };
export function validateFairExperimentRequest(request: FairExperimentRequest): ValidatedFairExperimentRequest {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return fail("Request must be an object.");
  const value = request as unknown as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowed.has(key))) return fail("Request contains an unknown property.");
  for (const key of ["repositoryPath", "task"] as const) if (typeof value[key] !== "string") return fail(`${key} must be a string.`);
  const repositoryPath = value.repositoryPath as string;
  const task = value.task as string;
  if (repositoryPath.trim()==="" || repositoryPath.includes("\0") || !isAbsolute(repositoryPath)) return fail("repositoryPath must be an absolute, non-empty path.");
  if (task.trim()==="" || task.includes("\0")) return fail("task must be non-blank and contain no null bytes.");
  try { normalizeTask(task); } catch (cause) { throw new ExperimentContractError("Task is not compatible with Stage 4 normalization.", "EXPERIMENT_REQUEST_INVALID", "request-validation", {}, cause); }
  if (value.controllerRoot !== undefined && (typeof value.controllerRoot !== "string" || value.controllerRoot.trim()==="" || value.controllerRoot.includes("\0") || !isAbsolute(value.controllerRoot))) return fail("controllerRoot must be absolute when provided.");
  if (value.contextBudget !== undefined && (typeof value.contextBudget !== "number" || !Number.isSafeInteger(value.contextBudget) || value.contextBudget <= 0)) return fail("contextBudget must be a positive safe integer.");
  if (value.experimentId !== undefined && (typeof value.experimentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.experimentId) || value.experimentId === "." || value.experimentId === "..")) return fail("experimentId is invalid.");
  return { repositoryPath, task, ...(value.controllerRoot===undefined?{}:{controllerRoot:value.controllerRoot as string}), ...(value.contextBudget===undefined?{}:{contextBudget:value.contextBudget as number}), ...(value.experimentId===undefined?{}:{experimentId:value.experimentId as string}) };
}
