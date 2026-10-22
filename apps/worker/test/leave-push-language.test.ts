import { describe, expect, it } from 'vitest';
import { leavePushMessage } from '../src/leave-notify.ts';

/**
 * The leave-decision push is Indonesian (ADR-034) and thin: the decision and
 * the dates, never the reason or the approver's comment.
 */
describe('leave push (ADR-034)', () => {
  it('is Indonesian', () => {
    expect(leavePushMessage(true, { startDate: '2027-03-01', endDate: '2027-03-01', totalDays: 1 })).toEqual({
      title: 'Pengajuan cuti Anda disetujui',
      body: '2027-03-01 · 1 hari',
    });
    expect(leavePushMessage(false, { startDate: '2027-03-01', endDate: '2027-03-03', totalDays: 3 }).title).toBe(
      'Pengajuan cuti Anda ditolak',
    );
  });
});
