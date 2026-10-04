/**
 * Doraha runs on India Standard Time (UTC+5:30, no daylight saving).
 * Cloud servers usually run in UTC, so NEVER use getDay()/getHours()/setHours()
 * for business rules (opening hours, "today's earnings"). Use these instead.
 */
export const BUSINESS_TZ = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** Day of week (0=Sun) and minutes since midnight, in Doraha time. */
export function istClock(now: Date = new Date()): { day: number; mins: number } {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  return {
    day: shifted.getUTCDay(),
    mins: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** The instant today began (00:00) in Doraha time. */
export function startOfTodayIST(now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
}
