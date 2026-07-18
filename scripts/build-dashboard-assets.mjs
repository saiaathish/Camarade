import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
execFileSync("npm", ["run", "build"], { cwd: join(root, "frontend"), stdio: "inherit" });
await rm(join(root, "dist/frontend"), { recursive: true, force: true });
await mkdir(join(root, "dist/frontend"), { recursive: true });
await cp(join(root, "frontend/dist"), join(root, "dist/frontend"), { recursive: true });
