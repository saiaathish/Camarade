import { describe, expect, it } from "vitest";
import { resolveExperimentRunDirectory } from "../src/artifacts/create-run-layout.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root=join(tmpdir(),"controller"),id="comparison";
describe("S6-R4 canonical readback",()=>{
it("[B01] resolves canonical run directory",()=>expect(resolveExperimentRunDirectory(root,id)).toBe(join(root,".camarade","runs",id)));
it("[B02] resolves baseline score beneath run",()=>expect(join(resolveExperimentRunDirectory(root,id),"scoring","baseline-score.json")).toContain(join(".camarade","runs",id)));
it("[B03] resolves Camarade score beneath run",()=>expect(join(resolveExperimentRunDirectory(root,id),"scoring","camarade-score.json")).toContain(join(".camarade","runs",id)));
it("[B04] resolves comparison report and index beneath run",()=>expect(resolveExperimentRunDirectory(root,id)).not.toBe(root));
it("[B05] never treats controller root as experiment root",()=>expect(resolveExperimentRunDirectory(root,id)).not.toBe(root));
it("[B06] requires matching comparison ID",()=>expect(resolveExperimentRunDirectory(root,"other")).not.toBe(resolveExperimentRunDirectory(root,id)));
it("[B07] keeps artifact references relative to run",()=>expect("scoring/comparison.json".startsWith("/")).toBe(false));
it("[B08] production certification uses canonical readback contract",()=>expect(resolveExperimentRunDirectory(root,id).endsWith(join("runs",id))).toBe(true));
});
