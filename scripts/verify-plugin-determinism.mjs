import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generated = [
  "plugins/camarade/mcp/server.mjs",
  "plugins/camarade/mcp/server.mjs.LEGAL.txt",
  "plugins/camarade/mcp/vendor/dictionary-en-LICENSE.txt",
  "plugins/camarade/mcp/vendor/index.aff.gz",
  "plugins/camarade/mcp/vendor/index.dic.gz",
  "plugins/camarade/mcp/vendor/typescript-LICENSE.txt",
  "plugins/camarade/mcp/vendor/typescript.cjs.gz",
];
const excludedRoots = [".artifacts", ".git", "coverage", "dist", "frontend/node_modules", "node_modules"];

async function hashes(repositoryRoot) {
  return Object.fromEntries(await Promise.all(generated.map(async (relativePath) => {
    const bytes = await readFile(path.join(repositoryRoot, relativePath));
    return [relativePath, createHash("sha256").update(bytes).digest("hex")];
  })));
}

function includeSource(source) {
  const relativePath = path.relative(root, source).replaceAll(path.sep, "/");
  return relativePath === "" || !excludedRoots.some((entry) => relativePath === entry || relativePath.startsWith(`${entry}/`));
}

async function cleanBuild(temporaryRoot, name) {
  const buildRoot = path.join(temporaryRoot, name);
  const cache = path.join(temporaryRoot, `${name}-npm-cache`);
  await cp(root, buildRoot, { recursive: true, filter: includeSource });
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined || npmCli.trim() === "") throw new Error("NPM_EXEC_PATH_UNAVAILABLE");
  await exec(process.execPath, [npmCli, "ci", "--ignore-scripts", "--cache", cache, "--prefer-online"], {
    cwd: buildRoot,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300_000,
  });
  await exec(process.execPath, [path.join(buildRoot, "scripts/build-plugin.mjs")], {
    cwd: buildRoot,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  return hashes(buildRoot);
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "camarade-plugin-determinism-"));
try {
  const first = await cleanBuild(temporaryRoot, "first");
  const second = await cleanBuild(temporaryRoot, "second");
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error(`PLUGIN_BUILD_NONDETERMINISTIC\nfirst=${JSON.stringify(first)}\nsecond=${JSON.stringify(second)}`);
  }
  const tracked = await hashes(root);
  if (JSON.stringify(first) !== JSON.stringify(tracked)) {
    throw new Error(`PLUGIN_BUILD_DIFFERS_FROM_TRACKED_RUNTIME\nclean=${JSON.stringify(first)}\ntracked=${JSON.stringify(tracked)}`);
  }
  try {
    await exec("git", ["diff", "--quiet", "--", ...generated], { cwd: root });
  } catch {
    throw new Error("PLUGIN_BUILD_DIFFERS_FROM_TRACKED_RUNTIME");
  }
  process.stdout.write(`${JSON.stringify({ status: "pass", cleanInstalls: 2, generated: first })}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
