import { logger } from './logger';

/**
 * Startup clock-drift safety net.
 *
 * Snipe timing is only as good as the server clock. Even with NTP active, this
 * gives an explicit, logged sanity check by comparing local time against the
 * `Date` header of a reliable HTTPS host (accounts for round-trip/2).
 *
 * Non-blocking: logs a warning if drift exceeds the threshold; never throws.
 *
 * NOTE: the HTTP `Date` header has only 1-second resolution, so this method
 * has ~1000ms inherent quantization error. It is a coarse sanity net only —
 * `chronyc tracking` on the host is the authoritative sub-ms drift source.
 * Threshold is set high (1500ms) to avoid false alarms from that rounding.
 */
export async function checkClockDrift(thresholdMs = 1500): Promise<number | null> {
  const url = 'https://www.cloudflare.com/cdn-cgi/trace';
  try {
    const start = Date.now();
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' } as RequestInit);
    const end = Date.now();
    const dateHeader = res.headers.get('date');
    if (!dateHeader) {
      logger.warn('[CLOCK] No Date header from time source; skipping drift check');
      return null;
    }
    const serverMs = new Date(dateHeader).getTime();
    // Estimate the true remote time at our local `end` by adding half RTT.
    const rtt = end - start;
    const localMidpoint = start + rtt / 2;
    const drift = localMidpoint - serverMs;

    if (Math.abs(drift) > thresholdMs) {
      logger.warn(
        `[CLOCK] ⚠️ Server clock drift ~${Math.round(drift)}ms (RTT ${rtt}ms). ` +
          `Snipe timing may be off. Check NTP: 'timedatectl' / 'chronyc tracking'.`
      );
    } else {
      logger.info(`[CLOCK] Drift ~${Math.round(drift)}ms (RTT ${rtt}ms) — within tolerance.`);
    }
    return drift;
  } catch (err) {
    logger.warn(`[CLOCK] Drift check failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return null;
  }
}
