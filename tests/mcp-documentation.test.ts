import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
const root=path.resolve(import.meta.dirname,"..");
describe("MCP documentation",()=>{it("documents the public MCP contract",async()=>{const readme=await readFile(path.join(root,"README.md"),"utf8"),docs=await readFile(path.join(root,"docs/mcp-server.md"),"utf8");for(const value of ["MCP","camarade.compile_task_context","npm run verify:mcp","docs/mcp-server.md"])expect(readme).toContain(value);for(const value of ["camarade","1.3.0","stdio","camarade.compile_task_context","repository_root","task","context_budget","intelligence_artifact","npm run mcp","npm run build","npm run verify:mcp","dist/src/mcp/start-server.js","CONTEXT_REQUEST_INVALID","execute a coding agent","execute validation commands"])expect(docs).toContain(value);});});
