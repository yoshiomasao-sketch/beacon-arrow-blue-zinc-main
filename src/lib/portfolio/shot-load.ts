/** How many times a visible image may be read before it needs a manual retry. */
export const SHOT_ATTEMPTS = 3;

/** A read that stays pending this long is treated as a failed attempt. */
export const SHOT_TIMEOUT_MS = 8000;

export function shotRetryDelay(attempt: number): number {
  return 400 * Math.max(1, attempt);
}

/** Missing bytes are not retried. Transient reads stop after SHOT_ATTEMPTS. */
export function shotAfterFailure(attempt: number, kind: "transient" | "missing"): "retry" | "missing" | "error" {
  if (kind === "missing") return "missing";
  if (attempt >= SHOT_ATTEMPTS) return "error";
  return "retry";
}
