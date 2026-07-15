import { describe, expect, it, vi } from "vitest";
import { createCamaradeMcpServer } from "../src/mcp/server.js";
import { COMPILE_TASK_CONTEXT_TOOL_NAME } from "../src/mcp/mcp-types.js";
describe("MCP server", () => { it("creates without starting transport or compiler", () => { const compiler = vi.fn(); const log = vi.spyOn(process.stdout, "write"); const server = createCamaradeMcpServer({ compiler }); expect(server).toBeDefined(); expect(compiler).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled(); log.mockRestore(); }); it("uses the exact tool name", () => expect(COMPILE_TASK_CONTEXT_TOOL_NAME).toBe("camarade.compile_task_context")); });
