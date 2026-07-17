import dictionary from "dictionary-en";
import nspell from "nspell";

const spell = nspell(Buffer.from(dictionary.aff), Buffer.from(dictionary.dic));

const PRODUCT_WORDS = [
  "api", "apis", "auth", "backend", "camarade", "cli", "codebase", "codex", "config",
  "configs", "css", "eslint", "frontend", "github", "html", "javascript", "json", "jsx",
  "localhost", "markdown", "middleware", "middlewares", "mcp", "npm", "repo", "repos",
  "sdk", "sql", "tsx", "typescript", "ui", "ux", "vite", "vitest", "worktree", "worktrees",
  "yaml", "zod"
] as const;

for (const word of PRODUCT_WORDS) spell.add(word);

const COMMON_CORRECTIONS = new Map<string, string>([
  ["acheive", "achieve"],
  ["adress", "address"],
  ["alot", "a lot"],
  ["arent", "aren't"],
  ["becuase", "because"],
  ["cant", "can't"],
  ["couldnt", "couldn't"],
  ["coudl", "could"],
  ["definately", "definitely"],
  ["definitly", "definitely"],
  ["dependancy", "dependency"],
  ["didnt", "didn't"],
  ["doesnt", "doesn't"],
  ["does'nt", "doesn't"],
  ["dont", "don't"],
  ["enviroment", "environment"],
  ["fucntion", "function"],
  ["funtion", "function"],
  ["im", "I'm"],
  ["implemnt", "implement"],
  ["implment", "implement"],
  ["isnt", "isn't"],
  ["limting", "limiting"],
  ["mesage", "message"],
  ["modle", "model"],
  ["occured", "occurred"],
  ["pls", "please"],
  ["recieve", "receive"],
  ["repositry", "repository"],
  ["seperate", "separate"],
  ["shoudl", "should"],
  ["speling", "spelling"],
  ["teh", "the"],
  ["thier", "their"],
  ["u", "you"],
  ["untill", "until"],
  ["ur", "your"],
  ["wich", "which"],
  ["wont", "won't"],
  ["wouldnt", "wouldn't"],
  ["woudl", "would"]
]);

function protectedRanges(value: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  const patterns = [
    /`[^`]*`/gu,
    /\b[a-z][a-z\d+.-]*:\/\/\S+/giu,
    /\b[^\s@]+@[^\s@]+\b/gu,
    /(?:^|\s)\S*(?:[\\/_]|\.[A-Za-z\d]{1,8}(?:[),.;:!?]|$))\S*/gu,
    /(?:^|\s)--?[A-Za-z][\w-]*/gu
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
    }
  }
  return ranges;
}

function isProtected(start: number, end: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([left, right]) => start < right && end > left);
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let beforePrevious = previous;
  let before = previous;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = before[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      let distance = Math.min(before[rightIndex] + 1, current[rightIndex - 1] + 1, substitution);
      if (leftIndex > 1 && rightIndex > 1
        && left[leftIndex - 1] === right[rightIndex - 2]
        && left[leftIndex - 2] === right[rightIndex - 1]) {
        distance = Math.min(distance, beforePrevious[rightIndex - 2] + 1);
      }
      current.push(distance);
    }
    beforePrevious = before;
    before = current;
  }
  return before[right.length];
}

function transferCase(source: string, correction: string): string {
  if (source.toLocaleUpperCase("en-US") === source) return correction.toLocaleUpperCase("en-US");
  if (/^[A-Z]/u.test(source)) return `${correction[0]?.toLocaleUpperCase("en-US") ?? ""}${correction.slice(1)}`;
  return correction;
}

function dictionaryCorrection(word: string): string | undefined {
  if (word.length < 4 || !/[aeiouy]/iu.test(word) || spell.correct(word)) return undefined;
  const suggestions = spell.suggest(word)
    .map((value) => value.toLocaleLowerCase("en-US"))
    .filter((value, index, values) => /^[a-z]+(?:'[a-z]+)?$/u.test(value) && values.indexOf(value) === index)
    .map((value) => ({ value, distance: editDistance(word.toLocaleLowerCase("en-US"), value) }))
    .filter(({ distance }) => distance === 1);
  if (suggestions.length !== 1) return undefined;
  return suggestions[0]?.value;
}

/**
 * Correct high-confidence English typos without sending text to a model.
 * Code spans, paths, URLs, flags, identifiers, acronyms, and ambiguous dictionary suggestions are preserved.
 */
export function correctTaskSpelling(value: string): string {
  const ranges = protectedRanges(value);
  return value.replace(/[A-Za-z]+(?:['’][A-Za-z]+)*/gu, (word, offset: number) => {
    const end = offset + word.length;
    if (isProtected(offset, end, ranges) || /[a-z][A-Z]/u.test(word) || /^[A-Z]{2,}$/u.test(word)) return word;
    const lower = word.toLocaleLowerCase("en-US").replaceAll("’", "'");
    const common = COMMON_CORRECTIONS.get(lower);
    const corrected = common ?? dictionaryCorrection(lower);
    return corrected === undefined ? word : transferCase(word, corrected);
  });
}
