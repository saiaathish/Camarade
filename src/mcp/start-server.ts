import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCamaradeMcpServer } from "./server.js";
export async function startCamaradeMcpServer(): Promise<void> { const server = createCamaradeMcpServer(); await server.connect(new StdioServerTransport()); }
startCamaradeMcpServer().catch(() => { console.error("Camarade MCP server failed to start."); process.exitCode = 1; });
