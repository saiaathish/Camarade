# Camarade MCP server

## Purpose

Camarade is a local stdio MCP server that compiles task-specific repository context. It uses Stage 3 repository intelligence and the Stage 4 compiler. It does not execute a coding agent, execute validation commands, or score an implementation.

## Requirements

The repository uses Node.js, npm, and Git as declared by the project setup. From a Camarade checkout:

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Development startup

```bash
npm run mcp
```

This starts the stdio transport for an MCP client. Human-readable logs must not be written to stdout because stdout carries MCP JSON-RPC. Stopping the client stops or closes the server process. Do not type tool requests manually into the terminal.

## Compiled startup

```bash
npm run build
node dist/src/mcp/start-server.js
```

An MCP client normally launches the compiled command.

## Server contract

- Server name: `camarade`
- Server version: `1.0.0`
- Transport: stdio

## Tool contract

The server exposes exactly one tool: `camarade.compile_task_context`.

Required inputs:

- `repository_root`: absolute path
- `task`: non-empty coding task

Optional inputs:

- `context_budget`: positive integer character maximum
- `intelligence_artifact`: safe repository-relative artifact path

Task text is preserved. The repository is analyzed read-only.

Example arguments (replace the placeholder path):

```json
{
  "repository_root": "/absolute/path/to/repository",
  "task": "Add rate limiting to the public search API",
  "context_budget": 12000
}
```

## Success response

```json
{
  "status": "complete",
  "compilation_id": "...",
  "repository_path": "...",
  "controller_root": "...",
  "contract": {},
  "summary": {},
  "provenance": {},
  "artifacts": {}
}
```

The `contract` contains the normalized task, goal, repository summary, architecture, requirements, constraints, relevant files, protected files, validation commands, unresolved decisions, excluded-context summary, budget, and provenance.

## Failure response

Illustrative shape:

```json
{
  "status": "failed",
  "code": "CONTEXT_REQUEST_INVALID",
  "stage": "repository-resolution",
  "message": "Repository cannot be resolved.",
  "evidence_path": null
}
```

Known compiler errors preserve stable code and stage. Unknown internal errors are sanitized. Stack traces are not returned through the tool result.

## Client configuration

Generic stdio launch contract:

```text
Command:
node

Arguments:
- /absolute/path/to/Camarade/dist/src/mcp/start-server.js
```

For clients using an `mcpServers`-style configuration, the following is a generic example; exact configuration-file location and outer field names depend on the MCP client:

```json
{
  "mcpServers": {
    "camarade": {
      "command": "node",
      "args": [
        "/absolute/path/to/Camarade/dist/src/mcp/start-server.js"
      ]
    }
  }
}
```

## Artifacts

Each compilation retains nine Stage 4 artifact files in an external controller root: `task-specification.json`, `candidates.json`, `decisions.json`, `context-contract.json`, `context-contract.md`, `excluded-context.json`, `unresolved-decisions.json`, `provenance.json`, and `compilation-summary.json`. Artifacts are outside the analyzed repository. The MCP response contains the contract directly; clients do not need to read artifact files to obtain context. Paths remain available for auditing.

## Security boundary

- Local stdio transport only
- No shell execution from tool input
- No coding-agent execution
- No validation-command execution
- No repository mutation
- No token usage claim
- No remote network service
- Input paths are validated

## Verification

```bash
npm run build
npm run verify:mcp
```

Verification starts the compiled server, discovers the tool, calls it, validates the response and artifact paths, and cleans temporary controller artifacts.
