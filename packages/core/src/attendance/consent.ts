import { writeAudit, type TenantClient } from '@hrms/db';

/**
 * Consent for attendance data processing (document 10 §8.2, Personal Data Protection Act No. 27/2022).
 *
 * Rule PR2 demands two things that are easy to say and easy to break: consent is
 * asked for **separately** from the application's general consent, and it **can
 * be withdrawn**.
 *
 * What keeps it from being a formality is the second part. Consent that can be
 * withdrawn but whose withdrawal changes nothing is not consent — it is a
 * notice. So withdrawal here is more than a database row:
 * `punchPermissions()`, which reads it, decides whether a location and a photo
 * may be COLLECTED at all, and its refusal applies on the server, not only on
 * the screen.
 *
 * What withdrawal does not change: the punch can still be made. Withdrawing
 * location consent means punching without a location, not losing the right to
 * attend — and its reasonable consequence is a lower trust score, which is
 * honest because there genuinely is less evidence.
 */

export type ConsentType = 'LOCATION' | 'PHOTO' | 'BIOMETRIC';

/**
 * The version of the consent text currently in force.
 *
 * Raised whenever the consent wording changes materially — a new purpose, a
 * longer retention, a new recipient. Raising it makes every old consent lapse
 * and its screen appear again, and that is the right behaviour: people consent
 * to wording, not to a feature name.
 */
export const CONSENT_VERSION: Record<ConsentType, string> = {
  LOCATION: '2026-08-lokasi-v1',
  PHOTO: '2026-08-foto-v1',
  BIOMETRIC: '2026-08-biometrik-v1',
};

export interface ConsentState {
  type: ConsentType;
  version: string;
  granted: boolean;
  grantedAt: string | null;
  withdrawnAt: string | null;
  /**
   * True when the employee has decided for the version of the text CURRENTLY in
   * force. False means the screen has to be shown — including to someone who
   * once consented to a previous version.
   */
  decided: boolean;
}

/** The kinds asked for in Phase 3. BIOMETRIC follows with Level 4. */
const ACTIVE_TYPES: ConsentType[] = ['LOCATION', 'PHOTO'];

export async function readConsents(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
): Promise<ConsentState[]> {
  const rows = await tx.attendanceConsent.findMany({
    where: { tenantId, employeeId, consentType: { in: ACTIVE_TYPES } },
    select: {
      consentType: true,
      version: true,
      grantedAt: true,
      withdrawnAt: true,
    },
  });

  return ACTIVE_TYPES.map((type) => {
    const version = CONSENT_VERSION[type];
    const row = rows.find((r) => r.consentType === type && r.version === version);

    return {
      type,
      version,
      // No row means NOT consented, not consented.
      //
      // This default direction carries the entire intent of the rule. Treating
      // silence as consent would collect every new employee's location before
      // they were ever asked, and that is precisely what is forbidden.
      granted: Boolean(row?.grantedAt && !row.withdrawnAt),
      grantedAt: row?.grantedAt?.toISOString() ?? null,
      withdrawnAt: row?.withdrawnAt?.toISOString() ?? null,
      decided: Boolean(row),
    };
  });
}

export interface ConsentDecision {
  type: ConsentType;
  grant: boolean;
  ip?: string | null | undefined;
}

export async function recordConsent(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  decision: ConsentDecision,
  actorUserId: string,
): Promise<ConsentState[]> {
  const version = CONSENT_VERSION[decision.type];
  const now = new Date();

  // The row for this version is updated, not added to. History across versions
  // stays whole because the version is part of the unique key — what is not kept
  // is the back-and-forth of consent and withdrawal within one version, and what
  // binds legally is its latest state.
  await tx.attendanceConsent.upsert({
    where: {
      tenantId_employeeId_consentType_version: {
        tenantId,
        employeeId,
        consentType: decision.type,
        version,
      },
    },
    create: {
      tenantId,
      employeeId,
      consentType: decision.type,
      version,
      grantedAt: decision.grant ? now : null,
      withdrawnAt: decision.grant ? null : now,
      ip: decision.ip ?? null,
    },
    update: decision.grant
      ? { grantedAt: now, withdrawnAt: null, ip: decision.ip ?? null }
      : { withdrawnAt: now, ip: decision.ip ?? null },
  });

  // Audited whichever direction it goes. A consent dispute is almost always "I
  // never consented to that", and what answers it is a record of when the button
  // was pressed and from which address.
  await writeAudit(tx, tenantId, {
    action: decision.grant ? 'attendance.consent.granted' : 'attendance.consent.withdrawn',
    entityType: 'attendance_consent',
    entityId: employeeId,
    actorUserId,
    after: { consentType: decision.type, version },
    ip: decision.ip ?? undefined,
  });

  return readConsents(tx, tenantId, employeeId);
}

export interface PunchPermissions {
  /** May send coordinates. */
  location: boolean;
  /** May send a selfie. */
  photo: boolean;
  /** Kinds not yet decided for the version of the text in force. */
  pending: ConsentType[];
}

/**
 * Translates consent into what may be sent with a punch.
 *
 * Called on the server before storing, not merely read by the screen. A screen
 * hiding the camera button is a convenience; what enforces the privacy promise
 * is the refusal on this side (P9).
 */
export async function punchPermissions(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
): Promise<PunchPermissions> {
  const consents = await readConsents(tx, tenantId, employeeId);
  const of = (type: ConsentType): ConsentState =>
    consents.find((consent) => consent.type === type)!;

  return {
    location: of('LOCATION').granted,
    photo: of('PHOTO').granted,
    pending: consents.filter((consent) => !consent.decided).map((consent) => consent.type),
  };
}
