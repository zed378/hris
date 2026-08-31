/**
 * Trust scoring for attendance evidence (document 10 §5, principle P14).
 *
 * The rule binding this whole file: **a score, not a yes/no.**
 *
 * Coordinates and photos are device claims, and every device claim can be
 * faked. A system that refuses a punch on one signal will refuse people who
 * genuinely worked — GPS inside a concrete warehouse is hundreds of metres out,
 * a cheap phone reports poor accuracy, and the mobile network in an industrial
 * estate drops the location onto the nearest mast.
 *
 * The right thing is to score it, flag what is suspicious, and leave the final
 * decision to a human who knows the context.
 *
 * The honesty boundary that has to be stated (document 10 §1.1): this system
 * CANNOT detect mock GPS from a browser. Web punching therefore always takes a
 * penalty and must never be sold as "spoof-proof".
 */

export interface TrustFlag {
  code: string;
  /** The score deduction. Positive. */
  penalty: number;
  message: string;
}

export interface TrustInput {
  source: 'WEB' | 'MOBILE' | 'DEVICE' | 'MANUAL';
  /** Distance to the nearest work site, in metres. Null when no location was sent. */
  distanceM: number | null;
  /** The geofence radius of the nearest site. */
  radiusM: number | null;
  /** The accuracy the device reported, in metres. */
  accuracyM: number | null;
  maxAccuracyM: number | null;
  /**
   * Tenant policy. Omitted means the defaults.
   *
   * A `false` `requireLocation`/`requirePhoto` means its absence does NOT lower
   * the score — not that the evidence is ignored when present. A consultancy
   * whose staff work from home does not need a photo on every punch; a
   * construction site does.
   */
  policy?: {
    requireLocation: boolean;
    requirePhoto: boolean;
    autoApproveThreshold: number;
  };
  hasPhoto: boolean;
  /** The device clock's offset from the server clock, in seconds. */
  clockSkewSeconds: number | null;
  /** The device reports a mock location. Only available in the native app. */
  mockLocationReported: boolean;
  /**
   * The request arrived from one of the tenant's configured office networks.
   *
   * The compensation document 11 §2.2 asks for. A browser cannot fake the
   * address its packets came from, so this is the one signal that survives the
   * absence of mock GPS detection — and it is the reason the web penalty below
   * is waived rather than merely reduced.
   *
   * It is never a bonus. Scoring above the baseline for being on the office
   * network would make a browser punch from the office score higher than the
   * same punch from a phone at the same desk, which is backwards.
   */
  officeIpVerified?: boolean | undefined;
  /**
   * Evidence that is missing BECAUSE the employee withdrew their consent
   * (Personal Data Protection Act).
   *
   * Distinguished from evidence that is merely absent, and that distinction
   * decides whether the consent is valid at all. If withdrawing location consent
   * sent every punch into the review queue, an employee would consent just to
   * stop being called in by HR — and consent given to avoid a consequence is not
   * free consent, and so is invalid under Personal Data Protection Act No. 27/2022.
   *
   * So its penalty is zero. The flag stays so the attendance record is honest
   * about why its evidence is thin, but it pushes nobody into the queue.
   */
  consentWithheld?: { location?: boolean; photo?: boolean } | undefined;
}

export interface TrustAssessment {
  score: number;
  flags: TrustFlag[];
  /** Below this threshold, a punch enters the HR review queue. */
  needsReview: boolean;
}

/**
 * The default review threshold.
 *
 * Chosen so one weak signal alone does not trigger a review, while a combination
 * of two does. The metric to watch: if more than 12% of punches enter the queue,
 * HR stops reviewing and the score becomes theatre (PLAN/12 §11).
 *
 * It is now configurable per tenant — precisely because of that metric. The right
 * threshold for a construction site is not the right threshold for a consultancy,
 * and one number for both means one of them floods its queue.
 */
const DEFAULT_REVIEW_THRESHOLD = 60;

export function assessTrust(input: TrustInput): TrustAssessment {
  const flags: TrustFlag[] = [];

  // --- Source ------------------------------------------------------------------
  if (input.source === 'WEB') {
    // Risk R47. A browser offers no API for detecting mock GPS, so web punching
    // is structurally weaker than native. Its penalty is small so it does not
    // trigger a review on its own — it becomes decisive only combined with
    // another signal.
    //
    // Unless the request came from the office network. That is the one claim a
    // browser cannot forge (see `office-network.ts`), and it answers the exact
    // doubt this penalty exists for: whether the location was invented. The flag
    // stays on the record either way, because "we could not check" and "we
    // checked and it came from the office" are different things and the reviewer
    // needs to see which one happened.
    flags.push(
      input.officeIpVerified
        ? {
            code: 'OFFICE_IP_VERIFIED',
            penalty: 0,
            message: 'Presensi dari jaringan kantor yang terdaftar',
          }
        : {
            code: 'WEB_UNVERIFIED_DEVICE',
            penalty: 15,
            message: 'Presensi dari peramban — keaslian lokasi tidak dapat diverifikasi',
          },
    );
  }

  if (input.source === 'MANUAL') {
    flags.push({
      code: 'MANUAL_ENTRY',
      penalty: 40,
      message: 'Diinput manual oleh HR, bukan oleh karyawan',
    });
  }

  /**
   * An attendance machine is not scored by phone standards.
   *
   * A punch from a fingerprint or face recognition machine carries no coordinates
   * and no selfie — and neither absence means its evidence is weak. Its location
   * is the machine itself, bolted to an office wall and impossible to take home.
   * Its identity is a fingerprint, harder to fake than any photo a browser sends.
   *
   * Without this exception a machine punch scores 50 — below the threshold — so
   * EVERY machine punch enters the review queue. For a tenant that does use a
   * machine, that queue holds all of their attendance, and HR stops reviewing on
   * day one.
   *
   * What is still scored is how it arrived. A CSV file is uploaded by a human and
   * its contents can be edited before uploading; the trust belongs to the machine,
   * not to the file. Its penalty is small so it does not trigger a review alone,
   * and it disappears once a direct integration replaces the import.
   */
  if (input.source === 'DEVICE') {
    flags.push({
      code: 'DEVICE_IMPORT_UNVERIFIED',
      penalty: 10,
      message: 'Dari impor berkas mesin absensi, bukan integrasi langsung',
    });

    const score = Math.max(0, 100 - flags.reduce((sum, flag) => sum + flag.penalty, 0));
    return { score, flags, needsReview: score < threshold(input) };
  }

  // --- Location ----------------------------------------------------------------
  if (input.distanceM === null) {
    flags.push(
      input.consentWithheld?.location
        ? {
            code: 'LOCATION_CONSENT_WITHHELD',
            penalty: 0,
            message: 'Tanpa lokasi — persetujuan lokasi tidak diberikan',
          }
        : {
            code: 'NO_LOCATION',
            // A tenant that genuinely does not require a location incurs no
            // penalty — but the flag STILL appears. Removing the flag would make
            // "no location" indistinguishable from "inside the fence", and that is
            // information lost with nobody asking for it.
            penalty: input.policy?.requireLocation === false ? 0 : 30,
            message: 'Tanpa data lokasi',
          },
    );
  } else if (input.radiusM !== null && input.distanceM > input.radiusM) {
    const excess = input.distanceM - input.radiusM;

    // A tiered penalty. Thirty metres outside the office fence is almost always
    // GPS imprecision; two kilometres almost always is not.
    const penalty = excess > 2000 ? 50 : excess > 500 ? 35 : excess > 100 ? 20 : 10;

    flags.push({
      code: 'OUTSIDE_GEOFENCE',
      penalty,
      message: `${formatDistance(input.distanceM)} dari lokasi kerja (radius ${input.radiusM} m)`,
    });
  }

  if (
    input.accuracyM !== null &&
    input.maxAccuracyM !== null &&
    input.accuracyM > input.maxAccuracyM
  ) {
    // Poor accuracy makes the distance untrustworthy in both directions — it can
    // hide someone far away and accuse someone close by. Its penalty is moderate,
    // and its message names the figure so HR can judge for themselves.
    flags.push({
      code: 'LOW_GPS_ACCURACY',
      penalty: 15,
      message: `Akurasi GPS ${input.accuracyM} m (batas ${input.maxAccuracyM} m)`,
    });
  }

  // --- Photo evidence ------------------------------------------------------------
  if (!input.hasPhoto) {
    flags.push(
      input.consentWithheld?.photo
        ? {
            code: 'PHOTO_CONSENT_WITHHELD',
            penalty: 0,
            message: 'Tanpa foto — persetujuan foto tidak diberikan',
          }
        : {
            code: 'NO_PHOTO',
            penalty: input.policy?.requirePhoto === false ? 0 : 20,
            message: 'Tanpa foto swafoto',
          },
    );
  }

  // --- Device time -----------------------------------------------------------------
  if (input.clockSkewSeconds !== null && Math.abs(input.clockSkewSeconds) > 300) {
    // A device clock more than five minutes out is a strong signal: it is the
    // simplest way to fake an offline punch. A five-minute tolerance leaves room
    // for a clock that is merely unsynchronised.
    flags.push({
      code: 'CLOCK_SKEW',
      penalty: 35,
      message: `Jam perangkat meleset ${Math.round(Math.abs(input.clockSkewSeconds) / 60)} menit`,
    });
  }

  // --- The strongest signal ----------------------------------------------------
  if (input.mockLocationReported) {
    // The only signal strong enough to trigger a review on its own. A device that
    // admits to using a mock location leaves no other reading.
    flags.push({
      code: 'MOCK_LOCATION',
      penalty: 70,
      message: 'Perangkat melaporkan penggunaan lokasi tiruan',
    });
  }

  const score = Math.max(0, 100 - flags.reduce((sum, flag) => sum + flag.penalty, 0));

  return { score, flags, needsReview: score < threshold(input) };
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${meters} m`;
}

/**
 * Haversine distance in metres.
 *
 * The earth is treated as a sphere, not an ellipsoid. The error reaches 0.5% —
 * on a 150-metre geofence radius that is under a metre, far below any GPS
 * imprecision. Vincenty is more accurate and offers nothing at all here.
 */
export function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6_371_000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** The review threshold in force for one assessment. */
function threshold(input: TrustInput): number {
  return input.policy?.autoApproveThreshold ?? DEFAULT_REVIEW_THRESHOLD;
}
