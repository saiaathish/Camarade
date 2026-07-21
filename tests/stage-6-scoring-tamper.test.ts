import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, symlink, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../src/context/context-serialization.js";
import { writeScoringArtifacts, validateScoringArtifacts, SCORING_ERROR_CODES } from "../src/evaluation/scoring-artifacts.js";
import type { ConditionScore } from "../src/evaluation/scoring.js";

const score=(condition:"baseline"|"camarade"):ConditionScore=>({condition,correctness:{score:40,measurableMaximum:40},requirementCompletion:{score:25,measurableMaximum:25},instructionCompliance:{score:20,measurableMaximum:20},changeFocus:{score:10,measurableMaximum:10},tokenEfficiency:{score:3,measurableMaximum:3},runtimeEfficiency:{score:2,measurableMaximum:2},efficiency:{score:5,measurableMaximum:5},total:100,measurableMaximum:100,scoreOutOf:100,limitations:[]});
const roots:string[]=[];
async function fixture(){const root=await mkdtemp(join(tmpdir(),"camarade-s6-tamper-")); roots.push(root); await writeScoringArtifacts(root,{experimentId:"e",baseline:score("baseline"),camarade:score("camarade"),status:"valid",officialBenchmarkEligible:true,outcome:"tie",delta:0,materialOverride:null,limitations:[],simulationLabel:"simulation"}); return root;}
async function index(root:string, mutate:(x:any)=>void=()=>{}){const p=join(root,"scoring/evidence-index.json");const x=JSON.parse(await readFile(p,"utf8"));mutate(x);await writeFile(p,canonicalJson(x));}
async function semantic(root:string,file:string, mutate:(x:any)=>void){const p=join(root,file);const x=JSON.parse(await readFile(p,"utf8"));mutate(x);await writeFile(p,canonicalJson(x));const i=JSON.parse(await readFile(join(root,"scoring/evidence-index.json"),"utf8"));const e=i.entries.find((a:any)=>a.relativePath===file)!;const bytes=await readFile(p);e.sha256=sha256(bytes);e.byteLength=bytes.length;i.entries.sort((a:any,b:any)=>a.relativePath.localeCompare(b.relativePath));i.aggregateHash=sha256(canonicalJson(i.entries));await writeFile(join(root,"scoring/evidence-index.json"),canonicalJson(i));}
const rejects=async(root:string,code:string)=>expect(validateScoringArtifacts(root)).rejects.toThrow(code);
describe("S6-R2 persisted tamper proof",()=>{
 afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
 it("[T01] rejects modified baseline score bytes",async()=>{const r=await fixture();await writeFile(join(r,"scoring/baseline-score.json"),"x\n");await rejects(r,SCORING_ERROR_CODES.hash)});
 it("[T02] rejects modified Camarade score bytes",async()=>{const r=await fixture();await writeFile(join(r,"scoring/camarade-score.json"),"x\n");await rejects(r,SCORING_ERROR_CODES.hash)});
 it("[T03] rejects modified comparison bytes",async()=>{const r=await fixture();await writeFile(join(r,"scoring/comparison.json"),"x\n");await rejects(r,SCORING_ERROR_CODES.hash)});
 it("[T04] rejects modified report bytes",async()=>{const r=await fixture();await writeFile(join(r,"scoring/REPORT.md"),"changed\n");await rejects(r,SCORING_ERROR_CODES.hash)});
 it("[T05] rejects changed index hash",async()=>{const r=await fixture();await index(r,x=>x.entries[0].sha256="0".repeat(64));await rejects(r,SCORING_ERROR_CODES.hash)});
 it("[T06] rejects changed index size",async()=>{const r=await fixture();await index(r,x=>x.entries[0].byteLength++);await rejects(r,SCORING_ERROR_CODES.size)});
 it("[T07] rejects changed artifact kind",async()=>{const r=await fixture();await index(r,x=>x.entries[0].kind="other");await rejects(r,SCORING_ERROR_CODES.kind)});
 it("[T08] rejects changed aggregate hash",async()=>{const r=await fixture();await index(r,x=>x.aggregateHash="0".repeat(64));await rejects(r,SCORING_ERROR_CODES.aggregate)});
 it("[T09] rejects reordered entries",async()=>{const r=await fixture();await index(r,x=>x.entries.reverse());await rejects(r,SCORING_ERROR_CODES.order)});
 it("[T10] rejects duplicate entry",async()=>{const r=await fixture();await index(r,x=>x.entries.push({...x.entries[0]}) );await rejects(r,SCORING_ERROR_CODES.duplicate)});
 it("[T11] rejects absolute entry path",async()=>{const r=await fixture();await index(r,x=>x.entries[0].relativePath="/private/x");await rejects(r,SCORING_ERROR_CODES.path)});
 it("[T12] rejects index self entry",async()=>{const r=await fixture();await index(r,x=>x.entries[0].relativePath="scoring/evidence-index.json");await rejects(r,SCORING_ERROR_CODES.self)});
 it("[T13] rejects changed baseline total",async()=>{const r=await fixture();await semantic(r,"scoring/comparison.json",x=>x.baselineTotal=99);await rejects(r,SCORING_ERROR_CODES.reference)});
 it("[T14] rejects changed Camarade total",async()=>{const r=await fixture();await semantic(r,"scoring/comparison.json",x=>x.camaradeTotal=99);await rejects(r,SCORING_ERROR_CODES.reference)});
 it("[T15] rejects changed delta",async()=>{const r=await fixture();await semantic(r,"scoring/comparison.json",x=>x.delta=2);await rejects(r,SCORING_ERROR_CODES.reference)});
 it("[T16] rejects changed baseline reference",async()=>{const r=await fixture();await semantic(r,"scoring/comparison.json",x=>x.baselineScoreReference="scoring/camarade-score.json");await rejects(r,SCORING_ERROR_CODES.reference)});
 it("[T17] rejects changed report reference",async()=>{const r=await fixture();await semantic(r,"scoring/comparison.json",x=>x.reportReference="x");await rejects(r,SCORING_ERROR_CODES.reference)});
 it("[T18] rejects limited win",async()=>{const r=await fixture();await semantic(r,"scoring/comparison.json",x=>{x.status="limited";x.officialBenchmarkEligible=false;x.outcome="win";x.limitations=["x"]});await rejects(r,SCORING_ERROR_CODES.outcome)});
 it("[T19] rejects invalid tie",async()=>{const r=await fixture();await semantic(r,"scoring/comparison.json",x=>{x.status="invalid";x.officialBenchmarkEligible=false;x.outcome="tie"});await rejects(r,SCORING_ERROR_CODES.outcome)});
 it("[T20] rejects valid null",async()=>{const r=await fixture();await semantic(r,"scoring/comparison.json",x=>x.outcome=null);await rejects(r,SCORING_ERROR_CODES.outcome)});
 it("[T21] rejects unknown override evidence",async()=>{const r=await fixture();await semantic(r,"scoring/comparison.json",x=>x.materialOverride={type:"material-rule",favoredCondition:"camarade",evidenceIds:["unknown"],reason:"x"});await rejects(r,SCORING_ERROR_CODES.override)});
 it("[T22] rejects contradictory override",async()=>{const r=await fixture();await semantic(r,"scoring/comparison.json",x=>x.materialOverride={type:"material-rule",favoredCondition:"camarade",evidenceIds:["a"],reason:"x"});await rejects(r,SCORING_ERROR_CODES.override)});
 it("[T23] rejects score arithmetic",async()=>{const r=await fixture();await semantic(r,"scoring/baseline-score.json",x=>x.total=99);await rejects(r,SCORING_ERROR_CODES.arithmetic)});
 it("[T24] rejects measurable maximum arithmetic",async()=>{const r=await fixture();await semantic(r,"scoring/baseline-score.json",x=>x.measurableMaximum=99);await rejects(r,SCORING_ERROR_CODES.arithmetic)});
 it("[T25] rejects report display mutation",async()=>{const r=await fixture();await writeFile(join(r,"scoring/REPORT.md"),"changed\n");await rejects(r,SCORING_ERROR_CODES.hash)});
 it("[T26] rejects removed simulation disclaimer",async()=>{const r=await fixture();await semantic(r,"scoring/comparison.json",x=>x.simulationLabel="experiment");await writeFile(join(r,"scoring/REPORT.md"),"changed\n");await rejects(r,SCORING_ERROR_CODES.hash)});
 it("[T27] rejects private absolute path",async()=>{const r=await fixture();await semantic(r,"scoring/comparison.json",x=>x.privatePath="/Users/private");await rejects(r,SCORING_ERROR_CODES.security)});
 it("[T28] rejects artifact symlink",async()=>{const r=await fixture();await unlink(join(r,"scoring/baseline-score.json"));await symlink(join(r,"scoring/camarade-score.json"),join(r,"scoring/baseline-score.json"));await rejects(r,SCORING_ERROR_CODES.symlink)});
 it("[T29] rejects an unsupported evidence-index version explicitly",async()=>{const r=await fixture();const d=await mkdtemp(join(tmpdir(),"outside-"));await writeFile(join(d,"baseline-score.json"),"x");await writeFile(join(r,"scoring/evidence-index.json"),"{}\n");await expect(validateScoringArtifacts(r)).rejects.toMatchObject({code:"UNSUPPORTED_ARTIFACT_VERSION"})});
 it("[T30] rejects evidence-index overwrite",async()=>{const r=await fixture();await expect(writeScoringArtifacts(r,{experimentId:"e",baseline:score("baseline"),camarade:score("camarade"),status:"valid",officialBenchmarkEligible:true,outcome:"tie",delta:0,materialOverride:null,limitations:[],simulationLabel:"simulation"})).rejects.toThrow(SCORING_ERROR_CODES.overwrite)});
});
