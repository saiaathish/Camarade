import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeGit } from "../src/experiment/git.js";
import { resolveExperimentStartingState } from "../src/experiment/resolve-experiment-starting-state.js";
describe("experiment starting state",()=>{it("captures commit, tree, and deterministic fingerprint",async()=>{const repo=await mkdtemp(join(tmpdir(),"s5-02-repo-"));const root=await mkdtemp(join(tmpdir(),"s5-02-root-"));await executeGit(repo,["init","-q"]);await executeGit(repo,["config","user.email","test@example.com"]);await executeGit(repo,["config","user.name","Test"]);await writeFile(join(repo,"README.md"),"hello\n");await executeGit(repo,["add","README.md"]);await executeGit(repo,["commit","-qm","init"]);const result=await resolveExperimentStartingState({repositoryPath:repo,controllerRoot:root,experimentId:"s5-test"});expect(result.startingState.startingCommit).toMatch(/^[0-9a-f]+$/);expect(result.startingState.startingTree).toMatch(/^[0-9a-f]+$/);expect(result.startingState.repositoryFingerprint).toMatch(/^[0-9a-f]{64}$/);expect(result.startingState.clean).toBe(true);});});
