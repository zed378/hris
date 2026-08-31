import { isIP } from 'node:net';

import type { TenantClient } from '@hrms/db';

/**
 * Office network verification (document 10 §2.4, document 11 §2.2).
 *
 * Web punching is structurally weaker than native punching, and document 11 §2.2
 * says why: a browser exposes no API for mock GPS detection, no root detection,
 * and no Wi-Fi SSID. Faking a location in a browser is DevTools → Sensors. That
 * is risk R47, and the trust score carries a permanent penalty for it.
 *
 * The compensation named in the same section is the one signal a browser cannot
 * forge: **the address the request actually arrived from.** A punch reaching the
 * server from the office network was made from a machine on that network — an
 * employee can move their GPS coordinates with a menu, and cannot move their
 * packets.
 *
 * That is a narrower claim than it first appears, and the narrowness matters:
 *
 *   - It proves the *connection* originates on that network, not that the person
 *     is inside the building. A VPN back to the office satisfies it exactly.
 *   - It is therefore treated as a reason to stop penalising a browser punch,
 *     not as evidence of presence. It never adds score above the baseline, and
 *     it never substitutes for a geofence.
 *
 * ## Why the ranges live on the work site
 *
 * A company with three branches has three networks, and a punch from the Bandung
 * office should be recognised as a Bandung punch. Hanging the list off the tenant
 * would flatten that, and the first tenant with two offices would find their
 * per-site recap meaningless.
 */

/**
 * The result of checking one address against a tenant's configured networks.
 *
 * `configured` is returned alongside `matched` on purpose. Without it, "no match"
 * cannot be told apart from "nothing to match against" — and those two demand
 * opposite behaviour from `FALLBACK_ONLY`: the first is a punch to refuse, the
 * second is a tenant who has not finished setting up, whose staff must not be
 * locked out of attendance because of it.
 */
export interface OfficeNetworkCheck {
  /** At least one active work site has a network configured. */
  configured: boolean;
  /** The address falls inside one of those networks. */
  matched: boolean;
}

/**
 * Reduces a client address to something PostgreSQL's `inet` will accept.
 *
 * Returns `null` for anything unusable, and the caller treats `null` as "no
 * match" rather than as an error. An unparseable address is not worth failing a
 * punch over: the person is standing at the gate, and the reason their proxy
 * sent something strange is not theirs to fix.
 *
 * Two normalisations are worth naming:
 *
 *   - **An IPv4-mapped IPv6 address** (`::ffff:203.0.113.7`) becomes its IPv4
 *     form. Node reports the mapped form on a dual-stack listener, and comparing
 *     it against an IPv4 range yields false — the two are different address
 *     families to PostgreSQL. Without this, an office network configured as
 *     `203.0.113.0/24` would silently never match anyone.
 *   - **A zone index** (`fe80::1%eth0`) is stripped. It is meaningful only on the
 *     machine that produced it, and `inet` refuses it.
 *
 * A port suffix is deliberately NOT stripped from an IPv4 address: `203.0.113.7`
 * and `203.0.113.7:54321` are ambiguous with IPv6 shorthand, and guessing wrong
 * would quietly widen or narrow the match.
 */
export function normaliseClientIp(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let ip = raw.trim();
  if (ip === '') return null;

  // Some proxies bracket IPv6 literals, with or without a port.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed?.[1]) ip = bracketed[1];

  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) ip = mapped[1];

  /**
   * `node:net` rather than a pair of regular expressions.
   *
   * The hand-written pair got `203.0.113.7:54321` wrong — one colon and only
   * digits and dots, so the IPv6 branch waved it through. That is not a cosmetic
   * miss: an address that survives this function reaches `::inet`, an invalid
   * literal makes the cast RAISE, and the raise aborts the punch transaction. The
   * comment two paragraphs up promises the opposite, that a strange proxy header
   * costs a match and never a punch. `isIP` is the parser that keeps the promise.
   */
  if (isIP(ip) === 0) return null;
  return ip;
}

/**
 * Checks an address against every active work site's networks.
 *
 * Raw SQL rather than Prisma, for the same reason the leave balance is read that
 * way: the work belongs in the database. `<<=` already knows about netmasks and
 * both address families, and a TypeScript reimplementation would be a second
 * definition of "inside the network" that is certain to disagree with the first
 * one day.
 *
 * The address is validated before it reaches the cast. An invalid literal makes
 * `::inet` raise, and a raise here would turn a strange proxy header into a
 * failed punch.
 */
export async function checkOfficeNetwork(
  tx: TenantClient,
  tenantId: string,
  rawIp: string | null | undefined,
): Promise<OfficeNetworkCheck> {
  const ip = normaliseClientIp(rawIp);

  const rows = await tx.$queryRaw<{ configured: boolean; matched: boolean }[]>`
    SELECT
      COALESCE(bool_or(cardinality(ip_ranges) > 0), false) AS configured,
      COALESCE(
        bool_or(
          ${ip}::inet IS NOT NULL
          AND EXISTS (SELECT 1 FROM unnest(ip_ranges) AS r WHERE ${ip}::inet <<= r)
        ),
        false
      ) AS matched
    FROM attendance.work_sites
    WHERE tenant_id = ${tenantId}::uuid AND is_active
  `;

  const row = rows[0];
  return {
    configured: row?.configured ?? false,
    matched: row?.matched ?? false,
  };
}
