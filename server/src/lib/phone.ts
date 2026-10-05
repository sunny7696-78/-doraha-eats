/**
 * Canonical Indian mobile number: "+91" + 10 digits starting 6-9.
 * Accepts "98765 43210", "09876543210", "919876543210", "+91 98765-43210".
 * Returns null for anything else, so junk never reaches the SMS provider.
 */
export function normalizeIndianPhone(input: string): string | null {
  let d = input.replace(/[\s\-().]/g, '');
  if (d.startsWith('+')) {
    if (!d.startsWith('+91')) return null;
    d = d.slice(3);
  } else if (d.startsWith('0091')) d = d.slice(4);
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
}

export const normalizeEmail = (e: string): string => e.trim().toLowerCase();
