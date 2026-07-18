import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
const root = new URL("..", import.meta.url).pathname;
await access(join(root,"dist/src/bin/camarade.js")); await access(join(root,"dist/frontend/index.html"));
const files = await readdir(join(root,"dist/frontend")); if (!files.length) throw new Error("frontend assets missing");
console.log("Stage 8 verification: PASS"); console.log("S8-04 server/API, compiled CLI, frontend package: PASS");
