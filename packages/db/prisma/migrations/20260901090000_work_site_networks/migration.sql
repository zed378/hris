-- =============================================================================
-- Office networks per work site (document 10 §2.4 and §3.2, document 11 §2.2)
-- =============================================================================
--
-- `attendance_policies.on_permission_denied` has accepted `FALLBACK_ONLY` since
-- the policy table was created: the settings screen offers it, the CHECK
-- constraint allows it, and the API stores it. **No code path ever behaved
-- differently for it.**
--
-- That is the same class of gap as `LEAVE`, `MANUAL`, `DISCARDED`, and the leave
-- accrual methods — a value that can be chosen and produces nothing. Here it is
-- worse than a wasted setting: a tenant who picks "only from the office network"
-- believes they have tightened something, and what they have actually done is
-- select a synonym for `ALLOW_FLAGGED`.
--
-- What `FALLBACK_ONLY` means (document 10 §2.4) is that a punch missing its
-- required evidence is accepted only from the office network. That demands a
-- list of networks, and there was nowhere to put one. This column is that place.
--
-- `INET[]`, not `TEXT[]`. PostgreSQL's `<<=` containment operator already
-- understands netmasks and both address families; a text comparison would have
-- to reimplement both, and would get IPv6 wrong in a way nobody notices until a
-- mobile carrier hands out an IPv6 address. The column type also refuses a
-- malformed range at write time rather than at the first punch of the morning.

SET LOCAL lock_timeout = '3s';

-- Adding a nullable-free column with a constant default rewrites nothing on
-- PostgreSQL 11+; it is a catalogue change (document 09 §2.1).
ALTER TABLE "attendance"."work_sites"
  ADD COLUMN IF NOT EXISTS "ip_ranges" INET[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN "attendance"."work_sites"."ip_ranges" IS
  'Office networks in CIDR form. A punch from one of these addresses counts as '
  'being on site even when its location evidence is thin (document 11 §2.2), and '
  'it is what the FALLBACK_ONLY policy checks. Empty means unconfigured, which '
  'degrades FALLBACK_ONLY to ALLOW_FLAGGED rather than locking everyone out.';
