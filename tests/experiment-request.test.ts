import { describe, expect, it } from "vitest";
import { validateFairExperimentRequest } from "../src/experiment/validate-experiment-request.js";
describe("fair experiment request", () => {
 it("preserves valid task bytes", () => { const task="  Add rate limiting to public search API\ntext  "; expect(validateFairExperimentRequest({repositoryPath:"/tmp/repo",task}).task).toBe(task); });
 it("rejects unsafe paths, budgets, IDs, and unknown keys", () => { expect(() => validateFairExperimentRequest({repositoryPath:"relative",task:"x"})).toThrow(); expect(() => validateFairExperimentRequest({repositoryPath:"/tmp",task:"x",contextBudget:0})).toThrow(); expect(() => validateFairExperimentRequest({repositoryPath:"/tmp",task:"x",experimentId:"../x"})).toThrow(); expect(() => validateFairExperimentRequest({repositoryPath:"/tmp",task:"x",extra:true} as never)).toThrow(); });
 it.each([
  ["blank repository", { repositoryPath:" ", task:"Add rate limiting to API" }],
  ["null repository", { repositoryPath:"/tmp/\0repo", task:"Add rate limiting to API" }],
  ["blank task", { repositoryPath:"/tmp", task:"  " }],
  ["null task", { repositoryPath:"/tmp", task:"Add\0 rate limiting to API" }],
  ["relative controller", { repositoryPath:"/tmp", task:"Add rate limiting to API", controllerRoot:"controller" }],
  ["negative budget", { repositoryPath:"/tmp", task:"Add rate limiting to API", contextBudget:-1 }],
  ["decimal budget", { repositoryPath:"/tmp", task:"Add rate limiting to API", contextBudget:1.5 }],
  ["dot ID", { repositoryPath:"/tmp", task:"Add rate limiting to API", experimentId:"." }],
  ["space ID", { repositoryPath:"/tmp", task:"Add rate limiting to API", experimentId:"bad id" }],
  ["slash ID", { repositoryPath:"/tmp", task:"Add rate limiting to API", experimentId:"bad/id" }],
  ["backslash ID", { repositoryPath:"/tmp", task:"Add rate limiting to API", experimentId:"bad\\id" }],
  ["ambiguous task", { repositoryPath:"/tmp", task:"task" }],
  ["non-object", null]
 ] as const)("rejects %s", (_label, value) => { expect(() => validateFairExperimentRequest(value as never)).toThrow(); });
});
