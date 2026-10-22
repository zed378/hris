/**
 * Email templates — in Indonesian (ADR-034).
 *
 * The one backend output written for people to read outside the frontend, so
 * the one place in the backend that speaks Indonesian. Words follow
 * `docs/UI-UX/13` §4. `notification-language.test.ts` pins the language so a
 * future translation pass cannot switch it silently, as one once did.
 *
 * Plain text, not HTML. Three reasons, and the third is decisive:
 * plain text filters better through spam filters, reads in any email client, and
 * cannot hide a link behind different-looking text — which is precisely the hallmark
 * of phishing emails that impersonate HR notifications.
 *
 * The tone is deliberately flat and specific. HR emails that sound like marketing
 * material get skimmed; those that mention a name, a date, and one concrete action
 * get read.
 */

function appUrl(path: string): string {
  const base = (process.env['APP_BASE_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}${path}`;
}

export interface RenderedEmail {
  subject: string;
  text: string;
}

export function passwordResetEmail(input: {
  tenantName: string;
  fullName: string;
  token: string;
  expiresAt: string;
}): RenderedEmail {
  const expires = formatDateTime(input.expiresAt);

  return {
    subject: `Atur ulang kata sandi — ${input.tenantName}`,
    text: [
      `Halo ${input.fullName},`,
      '',
      `Kami menerima permintaan untuk mengatur ulang kata sandi akun Anda di ${input.tenantName}.`,
      '',
      'Buka tautan berikut untuk menetapkan kata sandi baru:',
      appUrl(`/reset-password?token=${input.token}`),
      '',
      `Tautan ini berlaku sampai ${expires} dan hanya dapat dipakai sekali.`,
      '',
      // This is the line that makes a password reset email useful as a security
      // signal: the recipient who did not request it now knows someone is trying.
      'Bila Anda tidak meminta ini, abaikan surel ini — kata sandi Anda tidak berubah.',
      'Namun bila ini terulang, beri tahu bagian HR perusahaan Anda.',
      '',
      'Setelah kata sandi diganti, semua sesi Anda di perangkat lain akan berakhir.',
    ].join('\n'),
  };
}

export function invitationEmail(input: {
  tenantName: string;
  tenantCode: string;
  fullName: string;
  token: string;
  expiresAt: string;
}): RenderedEmail {
  return {
    subject: `Undangan bergabung — ${input.tenantName}`,
    text: [
      `Halo ${input.fullName},`,
      '',
      `Anda diundang untuk memakai sistem HR ${input.tenantName}.`,
      '',
      'Buka tautan berikut untuk menetapkan kata sandi Anda:',
      appUrl(`/accept-invitation?token=${input.token}`),
      '',
      `Tautan ini berlaku sampai ${formatDateTime(input.expiresAt)}.`,
      '',
      'Saat masuk nanti, Anda membutuhkan tiga hal:',
      `  Kode perusahaan : ${input.tenantCode}`,
      '  Surel           : alamat surel ini',
      '  Kata sandi      : yang Anda tetapkan lewat tautan di atas',
      '',
      // The company code is what most people get wrong on the first login attempt.
      // Stating it here saves one support ticket per new user.
      'Simpan kode perusahaan itu — ia diperlukan setiap kali Anda masuk.',
    ].join('\n'),
  };
}

/**
 * The actual remaining days, not the threshold label.
 *
 * A D7 threshold catches contracts with 0 to 7 days left. Writing "expires in
 * 7 days" for a contract with 5 days left makes HR plan two days late — and on
 * modules whose every value is about communicating the right deadline, that is
 * not a minor inaccuracy.
 */
function remainingText(daysLeft: number): string {
  if (daysLeft < 0) return 'SUDAH BERAKHIR';
  if (daysLeft === 0) return 'berakhir HARI INI';
  if (daysLeft === 1) return 'berakhir BESOK';
  return `berakhir dalam ${daysLeft} hari`;
}

export function contractExpiringEmail(input: {
  tenantName: string;
  employeeName: string;
  employeeNumber: string;
  contractNumber: string;
  contractType: string;
  endDate: string;
  daysLeft: number;
  threshold: string;
}): RenderedEmail {
  const expired = input.threshold === 'EXPIRED';

  const subject = expired
    ? `PERLU TINDAKAN: kontrak ${input.employeeName} sudah berakhir`
    : `Kontrak ${input.employeeName} ${remainingText(input.daysLeft)}`;

  const body = [
    `Kontrak kerja berikut ${remainingText(input.daysLeft)}:`,
    '',
    `  Karyawan        : ${input.employeeName} (${input.employeeNumber})`,
    `  Nomor kontrak   : ${input.contractNumber}`,
    `  Jenis           : ${input.contractType}`,
    `  Tanggal berakhir: ${formatDate(input.endDate)}`,
    '',
  ];

  if (expired) {
    // This warning is what makes the module worthwhile. A PKWT that is left
    // expired does not merely "need renewal" — its legal status changes, and
    // that change is irreversible.
    body.push(
      `Kontrak ini berakhir ${Math.abs(input.daysLeft)} hari lalu dan belum ditindaklanjuti.`,
      '',
      'PKWT yang dibiarkan berakhir tanpa perpanjangan atau pengakhiran resmi dapat',
      'dianggap beralih menjadi karyawan tetap (PKWTT) demi hukum. Peralihan ini tidak',
      'dapat dibatalkan. Hubungi bagian hukum atau HR senior sekarang.',
    );
  } else {
    body.push(
      'Perlu tindakan: perpanjang, angkat menjadi karyawan tetap, atau akhiri sesuai',
      'ketentuan. Keputusan harus diambil sebelum tanggal di atas.',
    );
  }

  body.push('', 'Lihat kontrak yang akan berakhir:', appUrl('/employees/contracts'));

  return { subject, text: [`Halo,`, '', ...body].join('\n') };
}

/**
 * Reminder for documents about to expire.
 *
 * Its content varies by document type, and that is what makes this email
 * valuable. "KITAS document will expire" cannot be actioned by anyone reading it
 * while walking past; "foreign workers working without a permit is a criminal
 * offence against the company" can.
 */
export function documentExpiringEmail(input: {
  tenantName: string;
  employeeName: string;
  employeeNumber: string;
  kind: string;
  title: string;
  expiresAt: string;
  daysLeft: number;
  threshold: string;
}): RenderedEmail {
  const expired = input.threshold === 'EXPIRED';

  const subject = expired
    ? `PERLU TINDAKAN: ${input.kind} ${input.employeeName} sudah berakhir`
    : `${input.kind} ${input.employeeName} ${remainingText(input.daysLeft)}`;

  const body = [
    `Dokumen berikut ${remainingText(input.daysLeft)}:`,
    '',
    `  Karyawan        : ${input.employeeName} (${input.employeeNumber})`,
    `  Jenis dokumen   : ${input.kind}`,
    `  Judul           : ${input.title}`,
    `  Berlaku sampai  : ${formatDate(input.expiresAt)}`,
    '',
  ];

  const konsekuensi = consequenceText(input.kind);
  if (konsekuensi) body.push(konsekuensi, '');

  if (expired) {
    body.push(
      `Dokumen ini berakhir ${Math.abs(input.daysLeft)} hari lalu dan belum diperbarui.`,
    );
  } else {
    body.push('Perpanjangan sebaiknya dimulai sekarang — sebagian izin butuh berminggu-minggu.');
  }

  body.push('', 'Lihat dokumen karyawan:', appUrl('/employees/documents'));

  return { subject, text: [`Halo,`, '', ...body].join('\n') };
}

/**
 * The consequence of letting this document expire.
 *
 * Only for types whose consequence is concrete and can be stated without guessing.
 * Other types get no sentence — a warning fabricated for every type only makes
 * the real ones ignored.
 */
function consequenceText(kind: string): string | null {
  switch (kind.toUpperCase()) {
    case 'KITAS':
    case 'IMTA':
      return (
        'KITAS/IMTA yang berakhir berarti tenaga kerja asing bekerja tanpa izin.\n' +
        'Menurut UU Keimigrasian No. 6/2011, ini tindak pidana bagi perusahaan dan\n' +
        'dapat berujung deportasi bagi yang bersangkutan.'
      );
    case 'SIM':
      return (
        'SIM yang berakhir berarti mengemudi tanpa izin. Klaim asuransi kendaraan dapat\n' +
        'ditolak pada kecelakaan pertama, dan tanggung jawabnya jatuh ke perusahaan.'
      );
    case 'SERTIFIKAT':
      return (
        'Sertifikat kompetensi yang berakhir dapat menggugurkan kelayakan untuk\n' +
        'pekerjaan yang mensyaratkannya.'
      );
    default:
      return null;
  }
}

function formatDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-');
  const months = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
  ];
  return `${Number(day)} ${months[Number(month) - 1]} ${year}`;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${formatDate(iso)} pukul ${String(date.getUTCHours()).padStart(2, '0')}:${String(
    date.getUTCMinutes(),
  ).padStart(2, '0')} UTC`;
}
