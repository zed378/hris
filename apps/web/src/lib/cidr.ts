import { isIP } from 'node:net';

import { z } from 'zod';

/**
 * An office network, in CIDR form.
 *
 * Validated here as well as by the `inet[]` column, and the duplication is
 * deliberate: the column answers a mistyped range with a PostgreSQL cast error,
 * which reaches the user as "something went wrong" on a form where the mistake
 * is one character in one field. This says which field.
 *
 * A bare address is accepted and means that single host — PostgreSQL reads
 * `203.0.113.7` as `/32`, which is what someone typing one address means.
 *
 * The address half is parsed by `node:net`, not by a regular expression written
 * here. An expression loose enough to accept every IPv6 shorthand also accepts
 * `203.0.113.7:54321`, which then reaches `::inet` and raises — turning a typo in
 * one field into a 500 on a form, which is the exact failure this schema exists
 * to prevent.
 */
export const cidrSchema = z
  .string()
  .trim()
  .min(3)
  .max(49)
  .refine(
    (value) => {
      const [addr, prefix, ...rest] = value.split('/');
      if (rest.length > 0 || !addr) return false;
      if (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) return false;

      const family = isIP(addr);
      if (family === 0) return false;

      // A prefix wider than the address family allows is not a network. Left to
      // PostgreSQL it raises; caught here it names the field.
      return prefix === undefined || Number(prefix) <= (family === 6 ? 128 : 32);
    },
    { message: 'Format jaringan harus seperti 203.0.113.0/24 atau 203.0.113.7' },
  );

/**
 * Ten ranges per site.
 *
 * Not a technical limit. A site needing more than ten is almost always someone
 * pasting a provider's whole allocation, and a range that wide stops meaning
 * "our office" — which is the only thing this list is evidence of.
 */
export const ipRangesSchema = z.array(cidrSchema).max(10);
