/**
 * Monotonic clock helpers for T-0 scheduling.
 *
 * `Date.now()` is wall-clock: it can jump backward/forward on NTP adjustment,
 * which corrupts duration math used to time a snipe. For measuring "how long
 * until the window opens" and "how long to wait", use a monotonic source that
 * only ever moves forward at a steady rate.
 *
 * Pattern:
 *   const anchor = monotonicMs();            // now, monotonic
 *   const target = anchor + msUntilOpen;     // computed once
 *   await sleepUntil(target);                // drift-free wait
 *
 * Wall-clock (Date.now / new Date) is still correct for EXTERNAL timestamps
 * (e.g. an OpenSea stage start_time). Only the local countdown uses monotonic.
 */

/** Monotonic milliseconds since an arbitrary origin (never goes backward). */
export function monotonicMs(): number {
  // performance.now() is monotonic on Node (backed by hrtime).
  return performance.now();
}

/** Sleep for a fixed duration (ms). */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/**
 * Sleep until a monotonic target timestamp. Re-checks in a final short spin so
 * a single long setTimeout can't overshoot after a scheduler stall.
 */
export async function sleepUntilMonotonic(targetMs: number): Promise<void> {
  // Coarse wait to within ~50ms, then tighten.
  for (;;) {
    const remaining = targetMs - monotonicMs();
    if (remaining <= 0) return;
    if (remaining > 50) {
      await sleep(remaining - 25);
    } else {
      await sleep(remaining);
      return;
    }
  }
}

/**
 * Convert a wall-clock "ms from now until event" into a monotonic target.
 * Snapshot both clocks once so the countdown is immune to later NTP jumps.
 */
export function monotonicTargetFromDelay(delayMs: number): number {
  return monotonicMs() + Math.max(0, delayMs);
}
