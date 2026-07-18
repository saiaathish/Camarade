import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const inputs = [
  "server.mjs",
  "vendor/index.aff.gz",
  "vendor/index.dic.gz",
  "vendor/typescript.cjs.gz"
];
const digest = createHash("sha256");
for (const input of inputs) digest.update(readFileSync(path.join(sourceRoot, input)));

const runtimeRoot = path.join(tmpdir(), `camarade-plugin-${digest.digest("hex").slice(0, 16)}`);
const ready = path.join(runtimeRoot, ".ready");

if (!existsSync(ready)) {
  const stagingRoot = `${runtimeRoot}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(path.join(stagingRoot, "vendor"), { recursive: true });
  copyFileSync(path.join(sourceRoot, "server.mjs"), path.join(stagingRoot, "server.mjs"));
  for (const [source, destination] of [
    ["vendor/index.aff.gz", "index.aff"],
    ["vendor/index.dic.gz", "index.dic"],
    ["vendor/typescript.cjs.gz", "vendor/typescript.cjs"]
  ]) {
    writeFileSync(path.join(stagingRoot, destination), gunzipSync(readFileSync(path.join(sourceRoot, source))));
  }
  writeFileSync(path.join(stagingRoot, ".ready"), "ready\n");
  try {
    renameSync(stagingRoot, runtimeRoot);
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    if (!existsSync(ready)) throw error;
  }
}

await import(pathToFileURL(path.join(runtimeRoot, "server.mjs")).href);
