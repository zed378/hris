import { describe, expect, it } from 'vitest';
import {
  contractExpiringEmail,
  documentExpiringEmail,
  invitationEmail,
  passwordResetEmail,
} from '../src/notification/templates.ts';

/**
 * Emails are Indonesian (ADR-034).
 *
 * They are the one backend output written for people to read outside the
 * frontend. A translation pass once switched them to English along with the
 * rest of the backend; the backend-language guard exempts this file, so only
 * this test stands between a future pass and the same mistake. It asserts the
 * subjects, and that no common English sentence word appears in any body.
 */

const ENGLISH = /\b(the|your|you|has|been|following|please|link|expires|contract|document|employee)\b/i;

const emails = {
  passwordReset: passwordResetEmail({
    tenantName: 'PT Contoh', fullName: 'Sari', token: 't', expiresAt: '2027-03-01T10:00:00Z',
  }),
  invitation: invitationEmail({
    tenantName: 'PT Contoh', tenantCode: 'contoh', fullName: 'Sari', token: 't', expiresAt: '2027-03-01T10:00:00Z',
  }),
  contract: contractExpiringEmail({
    tenantName: 'PT Contoh', employeeName: 'Sari', employeeNumber: 'E1', contractNumber: 'K-1',
    contractType: 'PKWT', endDate: '2027-03-01', daysLeft: 5, threshold: 'D7',
  }),
  contractExpired: contractExpiringEmail({
    tenantName: 'PT Contoh', employeeName: 'Sari', employeeNumber: 'E1', contractNumber: 'K-1',
    contractType: 'PKWT', endDate: '2027-03-01', daysLeft: -2, threshold: 'EXPIRED',
  }),
  document: documentExpiringEmail({
    tenantName: 'PT Contoh', employeeName: 'Sari', employeeNumber: 'E1', kind: 'KITAS',
    title: 'KITAS 2026', expiresAt: '2027-03-01', daysLeft: 10, threshold: 'D30',
  }),
};

describe('email language (ADR-034)', () => {
  it('writes the subjects in Indonesian', () => {
    expect(emails.passwordReset.subject).toBe('Atur ulang kata sandi — PT Contoh');
    expect(emails.invitation.subject).toBe('Undangan bergabung — PT Contoh');
    expect(emails.contract.subject).toBe('Kontrak Sari berakhir dalam 5 hari');
    expect(emails.contractExpired.subject).toMatch(/^PERLU TINDAKAN:/);
  });

  it.each(Object.entries(emails))('has no English sentence words in %s', (_name, email) => {
    // URLs are not prose: `/reset-password` would otherwise trip the check.
    const prose = email.text.replace(/https?:\/\/\S+/g, '');
    expect(prose).not.toMatch(ENGLISH);
  });

  it('dates the link in Indonesian', () => {
    expect(emails.passwordReset.text).toContain('1 Maret 2027 pukul 10:00 UTC');
  });
});
