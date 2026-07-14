export const MAX_PROCESS_TIMEOUT_MS = 2_147_483_647;

export function assertProcessTimeoutMilliseconds(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_PROCESS_TIMEOUT_MS) {
    throw new RangeError(
      `${label} must be greater than zero and at most ${MAX_PROCESS_TIMEOUT_MS} milliseconds.`
    );
  }
}

export function timeoutSecondsToMilliseconds(value: number, label: string): number {
  const milliseconds = value * 1_000;
  assertProcessTimeoutMilliseconds(milliseconds, label);
  return milliseconds;
}
