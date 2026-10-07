import { describe, it, expect } from 'vitest';
import { normalizeIndianPhone, normalizeEmail } from '../src/lib/phone.js';

describe('normalizeIndianPhone', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['98765 43210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['+91 98765-43210', '+919876543210'],
    ['0091 9876543210', '+919876543210'],
  ])('%s -> %s', (input, out) => expect(normalizeIndianPhone(input)).toBe(out));

  it.each(['12345', '5876543210', '+14155550123', '98765432101', 'abcdefghij', ''])(
    'rejects %s', (input) => expect(normalizeIndianPhone(input)).toBeNull());
});

it('lowercases and trims emails', () => expect(normalizeEmail('  Abc@Example.COM ')).toBe('abc@example.com'));
