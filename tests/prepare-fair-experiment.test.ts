import { describe, expect, it } from "vitest";
import { prepareFairExperiment } from "../src/experiment/prepare-fair-experiment.js";
describe("fair experiment preparation",()=>{it("exports the orchestrator",()=>expect(prepareFairExperiment).toBeTypeOf("function"));});
