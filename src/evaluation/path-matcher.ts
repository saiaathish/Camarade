function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
}

export function normalizeEvaluationPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
}

export function matchesPathPattern(path: string, pattern: string): boolean {
  const normalizedPath = normalizeEvaluationPath(path);
  const normalizedPattern = normalizeEvaluationPath(pattern);
  let expression = "";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index]!;
    if (character === "*" && normalizedPattern[index + 1] === "*") {
      const followedBySlash = normalizedPattern[index + 2] === "/";
      expression += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegex(character);
    }
  }
  return new RegExp(`^${expression}$`, "u").test(normalizedPath) || normalizedPath.startsWith(`${normalizedPattern}/`);
}

export function firstMatchingPattern(path: string, patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => matchesPathPattern(path, pattern));
}
