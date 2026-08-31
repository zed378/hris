import { describe, expect, it } from 'vitest';
import { normaliseClientIp } from '../src/attendance/office-network.ts';
import { assessTrust } from '../src/attendance/trust.ts';

/**
 * The address is the one signal a browser cannot forge (document 11 §2.2), so
 * every way of mangling it before it reaches PostgreSQL is a way of switching
 * the office-network check off without anyone noticing.
 *
 * Everything here fails silently by nature: a normalisation that returns `null`
 * one case too often does not raise, does not log, and does not change any
 * screen — it just means nobody ever matches, and `FALLBACK_ONLY` quietly stops
 * accepting the punches it was configured to accept.
 */
describe('normaliseClientIp', () => {
  it('passes plain addresses through unchanged', () => {
    expect(normaliseClientIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normaliseClientIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('trims surrounding whitespace left by a forwarded-for split', () => {
    expect(normaliseClientIp(' 203.0.113.7 ')).toBe('203.0.113.7');
  });

  /**
   * The case that would break the feature in production and nowhere else.
   *
   * Node reports `::ffff:203.0.113.7` on a dual-stack listener. PostgreSQL treats
   * that as a different address family from `203.0.113.0/24`, so `<<=` is false
   * and an office network configured the obvious way matches nobody — on the
   * deployed server only, while every local test with a literal IPv4 passes.
   */
  it('unwraps IPv4-mapped IPv6 to its IPv4 form', () => {
    expect(normaliseClientIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normaliseClientIp('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('unbrackets IPv6 literals, with and without a port', () => {
    expect(normaliseClientIp('[2001:db8::1]')).toBe('2001:db8::1');
    expect(normaliseClientIp('[2001:db8::1]:54321')).toBe('2001:db8::1');
  });

  it('strips a zone index that only means something on the host that wrote it', () => {
    expect(normaliseClientIp('fe80::1%eth0')).toBe('fe80::1');
  });

  /**
   * Rejected rather than repaired. The caller reads `null` as "no match", which
   * is the safe direction: a punch is refused for missing evidence, never
   * accepted because a malformed header was guessed into something plausible.
   */
  it('rejects anything PostgreSQL would raise on', () => {
    for (const bad of [
      null,
      undefined,
      '',
      '   ',
      'unknown',
      '203.0.113.999',
      '203.0.113',
      '203.0.113.7.8',
      'not-an-ip',
      '<script>',
      "203.0.113.7'; DROP TABLE attendance.work_sites; --",
    ]) {
      expect(normaliseClientIp(bad)).toBeNull();
    }
  });

  /**
   * A port is NOT stripped from an IPv4 address, and that is deliberate.
   *
   * `203.0.113.7:54321` is ambiguous with IPv6 shorthand, and a wrong guess
   * silently widens or narrows who counts as being on the office network. No
   * match is the honest answer.
   */
  it('does not guess at an IPv4 address carrying a port', () => {
    expect(normaliseClientIp('203.0.113.7:54321')).toBeNull();
  });
});

/**
 * What a verified office network does to the score, and — more importantly —
 * what it does not do.
 */
describe('office network in the trust score', () => {
  // A punch with nothing wrong with it: inside the fence, accurate, photographed.
  // The only thing under test is what the source flag does, so every other signal
  // is deliberately clean — a fixture missing a location would score 70 for a
  // reason that has nothing to do with the office network.
  const web = {
    source: 'WEB' as const,
    distanceM: 40,
    radiusM: 150,
    accuracyM: 20,
    maxAccuracyM: 100,
    hasPhoto: true,
    clockSkewSeconds: 0,
    mockLocationReported: false,
  };

  it('removes the browser penalty instead of adding score', () => {
    const unverified = assessTrust(web);
    const verified = assessTrust({ ...web, officeIpVerified: true });

    expect(unverified.flags.map((f) => f.code)).toContain('WEB_UNVERIFIED_DEVICE');
    expect(verified.flags.map((f) => f.code)).toContain('OFFICE_IP_VERIFIED');
    expect(verified.flags.map((f) => f.code)).not.toContain('WEB_UNVERIFIED_DEVICE');

    // The verified punch reaches the ceiling, and does not pass it. An office
    // network proves where the packets came from, not that anyone is in the
    // building — a VPN satisfies it exactly — so it can only undo a penalty.
    expect(verified.score).toBe(100);
    expect(verified.flags.find((f) => f.code === 'OFFICE_IP_VERIFIED')?.penalty).toBe(0);
  });

  /**
   * It compensates; it does not excuse.
   *
   * A punch from the office network that is two kilometres outside the geofence
   * is still two kilometres outside the geofence. If the flag could rescue that,
   * anyone on a company VPN would be able to punch from home unflagged, and the
   * whole geofence layer would be optional.
   */
  it('does not rescue a punch that failed the geofence', () => {
    const faraway = assessTrust({
      ...web,
      officeIpVerified: true,
      distanceM: 2000,
      radiusM: 150,
    });

    expect(faraway.flags.map((f) => f.code)).toContain('OUTSIDE_GEOFENCE');
    expect(faraway.score).toBeLessThan(100);
  });

  it('leaves native punches alone', () => {
    const device = assessTrust({ ...web, source: 'DEVICE', officeIpVerified: true });
    expect(device.flags.map((f) => f.code)).not.toContain('OFFICE_IP_VERIFIED');
    expect(device.flags.map((f) => f.code)).not.toContain('WEB_UNVERIFIED_DEVICE');
  });
});
