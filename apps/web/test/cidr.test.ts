import { describe, expect, it } from 'vitest';

import { cidrSchema, ipRangesSchema } from '../src/lib/cidr.ts';

/**
 * This schema stands between a text field and a PostgreSQL `inet[]` cast.
 *
 * Both directions of failure are silent in their own way. Too strict, and a
 * legitimate office network is rejected with a message the admin cannot act on.
 * Too loose, and the value reaches `::inet`, the cast raises, and a one-character
 * typo in one field surfaces as a 500 — on the very form whose purpose is to say
 * which field is wrong.
 */
describe('cidrSchema', () => {
  it('accepts networks and bare hosts, IPv4 and IPv6', () => {
    for (const value of [
      '203.0.113.0/24',
      '203.0.113.7',
      '10.0.0.0/8',
      '0.0.0.0/0',
      '2001:db8::/32',
      '2001:db8::1',
      '::1/128',
    ]) {
      expect(cidrSchema.safeParse(value).success, value).toBe(true);
    }
  });

  it('trims, because a pasted line brings its whitespace with it', () => {
    const parsed = cidrSchema.safeParse('  203.0.113.0/24  ');
    expect(parsed.success && parsed.data).toBe('203.0.113.0/24');
  });

  /**
   * The case a hand-written expression gets wrong: one colon, digits and dots
   * only, so an "is it IPv6?" charset test waves it straight through to the cast.
   */
  it('rejects an address carrying a port', () => {
    expect(cidrSchema.safeParse('203.0.113.7:54321').success).toBe(false);
    expect(cidrSchema.safeParse('203.0.113.7:54321/24').success).toBe(false);
  });

  it('rejects a prefix wider than its address family', () => {
    expect(cidrSchema.safeParse('203.0.113.0/33').success).toBe(false);
    expect(cidrSchema.safeParse('2001:db8::/129').success).toBe(false);
  });

  it('rejects malformed input rather than repairing it', () => {
    for (const value of [
      '',
      '203.0.113',
      '203.0.113.999/24',
      '203.0.113.0/24/8',
      '203.0.113.0/x',
      'office-wifi',
      '203.0.113.0 - 203.0.113.255',
      "203.0.113.0/24'; DROP TABLE attendance.work_sites; --",
    ]) {
      expect(cidrSchema.safeParse(value).success, value).toBe(false);
    }
  });

  /**
   * The message has to name the shape, not the rule. "Invalid CIDR" tells an HR
   * admin nothing; an example they can copy tells them everything.
   */
  it('explains the expected shape by example', () => {
    const parsed = cidrSchema.safeParse('office-wifi');
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain('203.0.113.0/24');
    }
  });
});

describe('ipRangesSchema', () => {
  it('accepts an empty list — no network configured is a valid state', () => {
    expect(ipRangesSchema.safeParse([]).success).toBe(true);
  });

  /**
   * The cap is a judgement, not a technical limit: past about ten entries the
   * list has stopped describing an office and started describing an ISP, and a
   * range that wide is evidence of nothing.
   */
  it('caps the list at ten', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `203.0.113.${i}`);
    expect(ipRangesSchema.safeParse(ten).success).toBe(true);
    expect(ipRangesSchema.safeParse([...ten, '203.0.113.99']).success).toBe(false);
  });

  it('rejects the whole list when one entry is malformed', () => {
    expect(ipRangesSchema.safeParse(['203.0.113.0/24', 'nope']).success).toBe(false);
  });
});
