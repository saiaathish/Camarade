import path from "node:path";

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_ABSOLUTE = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/;

export function isPortableAbsolutePath(value: string): boolean {
  return path.posix.isAbsolute(value) ||
    WINDOWS_DRIVE_ABSOLUTE.test(value) ||
    WINDOWS_UNC_ABSOLUTE.test(value);
}

export function hasPortableParentTraversal(value: string): boolean {
  return value.replaceAll("\\", "/").split("/").includes("..");
}

export function isSafePortableAbsolutePath(value: string): boolean {
  return value.trim() !== "" &&
    !value.includes("\0") &&
    isPortableAbsolutePath(value) &&
    !hasPortableParentTraversal(value);
}
