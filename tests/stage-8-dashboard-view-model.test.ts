import { describe, expect, it } from "vitest";
import { buildDashboardRun } from "../src/dashboard/build-dashboard-run.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
describe("S8-01 pure view model",()=>it("preserves outcome and impact while producing a validated view",()=>{const x=JSON.parse(readFileSync(join(process.cwd(),"fixtures/stage-8/dashboard/valid-camarade-win.json"),"utf8")); const result=buildDashboardRun(x); expect(result.outcome).toBe("win"); expect(result.conditions[1].impacts[0].direction).toBe("helped");}));
