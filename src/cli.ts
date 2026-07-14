import { fileURLToPath } from "node:url";

const SCAFFOLD_MESSAGE = "Camarade Stage 2 scaffold ready.";

export function getScaffoldMessage(): string {
  return SCAFFOLD_MESSAGE;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && fileURLToPath(import.meta.url) === entryPoint) {
  console.log(getScaffoldMessage());
}
