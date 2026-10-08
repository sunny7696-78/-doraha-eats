import { describe, it, expect } from 'vitest';
import { istClock, startOfTodayIST } from '../src/lib/time.js';
import { isVendorOpen, nextOpeningLabel } from '../src/services/vendorHours.service.js';

const hour = (dayOfWeek: number, opensAt: string, closesAt: string) => ({ dayOfWeek, opensAt, closesAt });

describe('India time, independent of the server time zone', () => {
  it('converts UTC instants to the Doraha clock', () => {
    expect(istClock(new Date('2026-10-07T05:00:00Z'))).toEqual({ day: 3, mins: 10 * 60 + 30 }); // Wed 10:30
    expect(istClock(new Date('2026-10-07T20:00:00Z'))).toEqual({ day: 4, mins: 90 });           // Thu 01:30 (next day in IST)
    expect(istClock(new Date('2026-10-07T18:29:00Z'))).toEqual({ day: 3, mins: 23 * 60 + 59 });  // Wed 23:59
    expect(istClock(new Date('2026-10-07T18:30:00Z'))).toEqual({ day: 4, mins: 0 });             // Thu 00:00
  });

  it('start of "today" is midnight IST (18:30 UTC the evening before)', () => {
    expect(startOfTodayIST(new Date('2026-10-07T05:00:00Z')).toISOString()).toBe('2026-10-06T18:30:00.000Z');
    expect(startOfTodayIST(new Date('2026-10-07T20:00:00Z')).toISOString()).toBe('2026-10-07T18:30:00.000Z');
  });

  it('a shop open 10:00-22:00 is open at 10:30 IST and closed at 22:30 IST (given as UTC)', () => {
    const wed = [hour(3, '10:00', '22:00')];
    expect(isVendorOpen(true, wed, new Date('2026-10-07T05:00:00Z'))).toBe(true);   // 10:30 IST
    expect(isVendorOpen(true, wed, new Date('2026-10-07T17:00:00Z'))).toBe(false);  // 22:30 IST
    expect(isVendorOpen(true, wed, new Date('2026-10-07T04:00:00Z'))).toBe(false);  // 09:30 IST
  });

  it('an overnight shop (18:00-02:00) is still open at 01:30 IST the next morning', () => {
    const wed = [hour(3, '18:00', '02:00')];
    expect(isVendorOpen(true, wed, new Date('2026-10-07T20:00:00Z'))).toBe(true);   // Thu 01:30 IST
    expect(isVendorOpen(true, wed, new Date('2026-10-07T21:30:00Z'))).toBe(false);  // Thu 03:00 IST
  });

  it('"opens at" label uses IST', () => {
    expect(nextOpeningLabel([hour(3, '10:00', '22:00')], new Date('2026-10-07T01:00:00Z'))).toBe('Opens at 10:00'); // 06:30 IST
  });
});
