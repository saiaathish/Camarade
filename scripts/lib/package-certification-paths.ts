import { realpath } from "node:fs/promises";

/** Resolve the certification workspace before any child path is derived. */
export async function canonicalizePackageCertificationRoot(createdRoot: string): Promise<string> {
  return realpath(createdRoot);
}
