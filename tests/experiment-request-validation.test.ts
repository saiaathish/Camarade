import { describe, expect, it } from "vitest";
import { validateFairExperimentRequest } from "../src/experiment/validate-experiment-request.js";

const valid = () => ({
  repositoryPath: process.cwd(),
  task: "Implement the requested change",
  controllerRoot: process.cwd(),
  contextBudget: 12_000,
  experimentId: "experiment-1",
});

describe("fair experiment request validation", () => {
  it("accepts and preserves the complete supported request shape", () => {
    expect(validateFairExperimentRequest(valid())).toEqual(valid());
  });

  it.each([
    ["unknown field", { ...valid(), unknown: true }],
    ["relative repository", { ...valid(), repositoryPath: "relative" }],
    ["blank task", { ...valid(), task: " " }],
    ["relative controller", { ...valid(), controllerRoot: "relative" }],
    ["zero budget", { ...valid(), contextBudget: 0 }],
    ["traversing experiment id", { ...valid(), experimentId: ".." }],
    ["relative evaluation definition", { ...valid(), evaluationDefinitionPath: "definition.json" }],
  ])("rejects %s", (_label, request) => {
    expect(() => validateFairExperimentRequest(request)).toThrow();
  });
});
