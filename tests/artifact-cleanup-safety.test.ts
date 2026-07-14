import { mkdtemp, readFile, readdir, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  failClose: false,
  failUnlink: false
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    open: async (path: string, flags: string | number, mode?: number): Promise<FileHandle> => {
      const handle = await actual.open(path, flags, mode);
      let closed = false;
      return {
        writeFile: handle.writeFile.bind(handle),
        sync: handle.sync.bind(handle),
        close: async () => {
          if (closed) return;
          await handle.close();
          closed = true;
          if (mockState.failClose) throw new Error("simulated close failure");
        }
      } as unknown as FileHandle;
    },
    unlink: async (path: string) => {
      if (mockState.failUnlink) throw new Error("simulated unlink failure");
      return actual.unlink(path);
    }
  };
});

import { ArtifactWriteError, writeJsonExclusive } from "../src/artifacts/write-manifest.js";

const roots: string[] = [];

async function tempFiles(root: string): Promise<string[]> {
  return (await readdir(root)).filter((entry) => entry.endsWith(".tmp"));
}

afterEach(async () => {
  mockState.failClose = false;
  mockState.failUnlink = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("atomic artifact cleanup safety", () => {
  it("surfaces temporary close failures and still cleans the temporary file when possible", async () => {
    const root = await mkdtemp(join(tmpdir(), "camarade-artifact-close-"));
    roots.push(root);
    mockState.failClose = true;

    await expect(writeJsonExclusive(join(root, "manifest.json"), { value: 1 }, "Run manifest"))
      .rejects.toMatchObject({
        name: "ArtifactWriteError",
        message: expect.stringContaining("Failed while closing Run manifest")
      });
    expect(await tempFiles(root)).toEqual([]);
  });

  it("surfaces unlink cleanup failures after publishing and preserves the final artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "camarade-artifact-unlink-"));
    roots.push(root);
    const artifactPath = join(root, "manifest.json");
    mockState.failUnlink = true;

    await expect(writeJsonExclusive(artifactPath, { value: 1 }, "Run manifest"))
      .rejects.toMatchObject({
        name: "ArtifactWriteError",
        message: expect.stringContaining("simulated unlink failure")
      });
    expect(JSON.parse(await readFile(artifactPath, "utf8"))).toEqual({ value: 1 });
    expect(await tempFiles(root)).toHaveLength(1);
  });

  it("returns one error containing primary publish and cleanup failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "camarade-artifact-combined-"));
    roots.push(root);
    const artifactPath = join(root, "manifest.json");
    await writeFile(artifactPath, "preserved evidence\n");
    mockState.failUnlink = true;

    const failure = await writeJsonExclusive(artifactPath, { value: 2 }, "Run manifest")
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ArtifactWriteError);
    expect(failure).toMatchObject({
      message: expect.stringContaining("already exists; refusing to overwrite preserved evidence")
    });
    expect((failure as Error).message).toContain("cleanup failed");
    expect((failure as Error).message).toContain("simulated unlink failure");
    expect(await readFile(artifactPath, "utf8")).toBe("preserved evidence\n");
    expect(await tempFiles(root)).toHaveLength(1);
  });
});
