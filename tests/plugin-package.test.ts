import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const pluginRoot = path.join(root, "plugins/camarade");

describe("Camarade plugin package", () => {
  it("publishes coherent marketplace, manifest, skill, and assets", async () => {
    const marketplace = JSON.parse(await readFile(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));
    const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
    const mcp = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8"));
    const skill = await readFile(path.join(pluginRoot, "skills/improve-coding-prompt/SKILL.md"), "utf8");

    expect(marketplace).toMatchObject({
      name: "camarade",
      plugins: [{ name: "camarade", source: { source: "local", path: "./plugins/camarade" } }]
    });
    expect(manifest).toMatchObject({
      name: "camarade",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      interface: { composerIcon: "./assets/camarade-mark.svg" }
    });
    expect(mcp.mcpServers.camarade).toEqual({
      command: "node",
      args: ["./mcp/bootstrap.mjs"],
      cwd: "."
    });
    expect(skill).toContain("name: improve-coding-prompt");
    expect(skill).not.toContain("TODO");
    await access(path.join(pluginRoot, "assets/camarade-mark.svg"));
    await access(path.join(pluginRoot, "mcp/server.mjs"));
    await access(path.join(pluginRoot, "mcp/server.mjs.LEGAL.txt"));
    await access(path.join(pluginRoot, "mcp/bootstrap.mjs"));
    await access(path.join(pluginRoot, "mcp/vendor/index.aff.gz"));
    await access(path.join(pluginRoot, "mcp/vendor/index.dic.gz"));
    await access(path.join(pluginRoot, "mcp/vendor/typescript.cjs.gz"));
    await access(path.join(pluginRoot, "mcp/vendor/typescript-LICENSE.txt"));
    await access(path.join(pluginRoot, "mcp/vendor/dictionary-en-LICENSE.txt"));
  });

  it("starts the bundled MCP runtime without repository dependencies", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "camarade-plugin-test-"));
    const client = new Client({ name: "camarade-plugin-verifier", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(pluginRoot, "mcp/bootstrap.mjs")],
      cwd: pluginRoot,
      env: { TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot },
      stderr: "pipe"
    });

    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "camarade.compile_task_context",
        "camarade.run_fair_experiment",
        "camarade.measure_experiment",
        "camarade.explain_experiment"
      ]);
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
