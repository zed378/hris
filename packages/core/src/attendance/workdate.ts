import type { TenantClient } from '@hrms/db';

/**
 * Working day boundaries (document 10 §3).
 *
 * A "working day" is the calendar date where the person works, not the UTC date
 * at the same moment. The difference is seven to nine hours for Indonesia, and
 * those seven hours fall precisely in the morning.
 *
 * The first version computed it with `getUTCHours()`. For WIB (UTC+7) the
 * result: every punch between 06:00 and 10:59 landed on YESTERDAY's date. Not
 * an edge case — that is almost everyone's arrival window. Every working day
 * would look like a clock-out with no clock-in, each one counted ABSENT, and
 * every salary deduction that followed wrong with not one error appearing.
 *
 * Written without a timezone library. `Intl.DateTimeFormat` already carries the
 * IANA database inside the runtime, so adding date-fns-tz or luxon would only
 * duplicate data that is already there — along with the duty of updating it.
 */

/** A punch before this hour belongs to the previous working day. */
const NIGHT_SHIFT_CUTOFF_HOUR = 4;

export interface ZonedParts {
  year: number;
  /** 1-12, not 0-11. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * Splits one instant into its calendar parts in a given zone.
 *
 * Uses `formatToParts` rather than offset arithmetic because a zone's offset is
 * not a constant: it changes with DST, and has changed permanently several times
 * when a country changed its rules. Indonesia does not use DST — but the first
 * tenant with an office outside Indonesia would discover that assumption in an
 * expensive way.
 */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };

  // `hour12: false` reports midnight as 24 on some runtimes.
  const hour = value('hour') % 24;

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour,
    minute: value('minute'),
  };
}

/**
 * Decides a punch's working date.
 *
 * Its return value is UTC midnight on that date, because that is the shape a
 * PostgreSQL `date` column uses — a date without a time, not a point in time.
 * Storing it as a local instant would make the same date hold different values
 * depending on who wrote it.
 */
export function resolveWorkDate(punchedAt: Date, timeZone: string): Date {
  const local = zonedParts(punchedAt, timeZone);

  // An early-morning punch belongs to a shift that started last night. The
  // threshold is applied to the LOCAL hour — that is the only difference from
  // the previous version, and the only one needed.
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day));
  if (local.hour < NIGHT_SHIFT_CUTOFF_HOUR) {
    date.setUTCDate(date.getUTCDate() - 1);
  }

  return date;
}

/** `2026-08-10` in the given zone. */
export function zonedDateString(instant: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(instant, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * A zone's offset from UTC at one point in time, in milliseconds.
 *
 * Computed rather than stored. A zone's offset is a function of its time —
 * `Asia/Jakarta` does stay +7 all year, but other zones do not, and the only
 * thing that distinguishes them is the IANA database inside the runtime.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  // The instant is rounded to the minute because `zonedParts` only goes to the minute.
  return asIfUtc - Math.floor(instant.getTime() / 60_000) * 60_000;
}

/**
 * The instant for a local wall clock time on a working date.
 *
 * Used to compare a punch against its shift schedule. A shift's `startMinute` is
 * minutes since LOCAL midnight — a morning shift is 480, and that 480 means
 * 08:00 where the person works, not 08:00 UTC.
 *
 * Adding it straight onto UTC midnight shifts the whole schedule by the zone
 * offset: for WIB, the morning shift becomes 15:00 in the afternoon, so nobody
 * is ever recorded as late.
 *
 * Two steps because the offset depends on an instant that is not yet known: the
 * first guess treats the wall clock time as UTC, then corrects it with the
 * offset in force around that guess.
 */
export function localMinutesToInstant(
  workDateUtcMidnight: Date,
  minutesSinceMidnight: number,
  timeZone: string,
): Date {
  const wallClock = workDateUtcMidnight.getTime() + minutesSinceMidnight * 60_000;
  const firstGuess = new Date(wallClock - zoneOffsetMs(new Date(wallClock), timeZone));
  return new Date(wallClock - zoneOffsetMs(firstGuess, timeZone));
}

/**
 * The tenant's timezone, with a safe fallback.
 *
 * `Asia/Jakarta` is used when the column is empty. That fallback is deliberately
 * a real zone rather than UTC: a tenant whose row is not filled in is almost
 * certainly in WIB, and UTC would repeat exactly the mistake this column exists
 * to fix.
export async function tenantTimeZone(tx: TenantClient, tenantId: string): Promise<string> {
  const tenant = await tx.tenant.findFirst({
    where: { id: tenantId },
    select: { timezone: true },
  });
  return tenant?.timezone || 'Asia/Jakarta';
}
