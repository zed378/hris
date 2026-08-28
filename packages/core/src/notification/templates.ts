/**
 * Templat email.
 *
 * Teks biasa, bukan HTML. Tiga alasan, dan yang ketiga yang paling menentukan:
 * teks lolos filter spam lebih baik, terbaca di klien email apa pun, dan tidak
 * dapat menyembunyikan tautan di balik tulisan yang berbeda — yang justru ciri
 * khas email phishing yang meniru pemberitahuan HR.
 *
 * Nada tulisannya sengaja datar dan spesifik. Email dari sistem HR yang berbunyi
 * seperti materi pemasaran akan dilewatkan; yang menyebutkan nama, tanggal, dan
 * satu tindakan yang jelas akan dibaca.
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
      'Buka tautan berikut untuk memasang kata sandi baru:',
      appUrl(`/reset-password?token=${input.token}`),
      '',
      `Tautan ini berlaku sampai ${expires} dan hanya dapat dipakai satu kali.`,
      '',
      // Kalimat ini yang membuat email reset kata sandi berguna sebagai sinyal
      // keamanan: penerima yang tidak meminta apa pun kini tahu ada yang mencoba.
      'Jika Anda tidak meminta ini, abaikan email ini — kata sandi Anda tidak berubah.',
      'Namun bila ini berulang, beri tahu admin HR perusahaan Anda.',
      '',
      'Setelah kata sandi diganti, seluruh sesi Anda di perangkat lain akan berakhir.',
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
      `Anda diundang untuk mengakses sistem HR ${input.tenantName}.`,
      '',
      'Buka tautan berikut untuk memasang kata sandi Anda:',
      appUrl(`/accept-invitation?token=${input.token}`),
      '',
      `Tautan ini berlaku sampai ${formatDateTime(input.expiresAt)}.`,
      '',
      'Saat masuk nanti, Anda akan diminta tiga hal:',
      `  Kode perusahaan : ${input.tenantCode}`,
      '  Email           : alamat email ini',
      '  Kata sandi      : yang Anda pasang lewat tautan di atas',
      '',
      // Kode perusahaan adalah bagian yang paling sering membuat orang gagal
      // masuk pada percobaan pertama. Menyebutkannya di sini menghemat satu
      // tiket dukungan per pengguna baru.
      'Simpan kode perusahaan tersebut — ia dibutuhkan setiap kali masuk.',
    ].join('\n'),
  };
}

/**
 * Sisa hari yang SEBENARNYA, bukan label ambangnya.
 *
 * Ambang D7 menangkap kontrak dengan sisa 0 sampai 7 hari. Menulis "berakhir
 * dalam 7 hari" untuk kontrak yang tersisa 5 hari membuat HR merencanakan dua
 * hari terlambat — dan pada modul yang seluruh nilainya adalah menyampaikan
 * tenggat yang benar, itu bukan ketidaktelitian kecil.
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
    `  Karyawan       : ${input.employeeName} (${input.employeeNumber})`,
    `  Nomor kontrak  : ${input.contractNumber}`,
    `  Jenis          : ${input.contractType}`,
    `  Tanggal berakhir: ${formatDate(input.endDate)}`,
    '',
  ];

  if (expired) {
    // Peringatan ini yang membuat modul ini bernilai. PKWT yang lewat tidak
    // sekadar "terlambat diperpanjang" — statusnya berubah demi hukum, dan
    // perubahan itu tidak dapat dibatalkan.
    body.push(
      `Kontrak ini berakhir ${Math.abs(input.daysLeft)} hari lalu dan belum ditindaklanjuti.`,
      '',
      'PKWT yang dibiarkan lewat tanpa perpanjangan atau pengakhiran resmi dapat',
      'dianggap berubah menjadi PKWTT (karyawan tetap) demi hukum. Perubahan itu',
      'tidak dapat dibatalkan. Segera hubungi bagian hukum atau HR senior Anda.',
    );
  } else {
    body.push(
      'Tindakan yang perlu diputuskan: perpanjang, angkat menjadi karyawan tetap,',
      'atau akhiri sesuai ketentuan. Keputusan perlu diambil sebelum tanggal di atas.',
    );
  }

  body.push('', 'Lihat daftar kontrak yang akan berakhir:', appUrl('/employees/contracts'));

  return { subject, text: [`Halo,`, '', ...body].join('\n') };
}

/**
 * Pengingat dokumen yang akan kedaluwarsa.
 *
 * Isinya berbeda menurut jenis dokumen, dan itu yang membuat email ini bernilai.
 * "Dokumen KITAS akan berakhir" tidak dapat ditindaklanjuti siapa pun yang
 * membacanya sambil lalu; "tenaga kerja asing bekerja tanpa izin adalah pidana
 * bagi perusahaan" dapat.
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
    ? `PERLU TINDAKAN: ${input.kind} ${input.employeeName} sudah kedaluwarsa`
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
      `Dokumen ini kedaluwarsa ${Math.abs(input.daysLeft)} hari lalu dan belum diperbarui.`,
    );
  } else {
    body.push('Perpanjangan perlu dimulai sekarang — sebagian izin memakan waktu berminggu-minggu.');
  }

  body.push('', 'Lihat dokumen karyawan:', appUrl('/employees/documents'));

  return { subject, text: [`Halo,`, '', ...body].join('\n') };
}

/**
 * Akibat yang menunggu bila dokumen ini dibiarkan lewat.
 *
 * Hanya untuk jenis yang akibatnya konkret dan dapat dinyatakan tanpa menebak.
 * Jenis lain tidak diberi kalimat apa pun — peringatan yang dikarang untuk
 * setiap jenis dokumen akan membuat yang sungguhan ikut diabaikan.
 */
function consequenceText(kind: string): string | null {
  switch (kind.toUpperCase()) {
    case 'KITAS':
    case 'IMTA':
      return (
        'KITAS/IMTA yang kedaluwarsa berarti tenaga kerja asing bekerja tanpa izin.\n' +
        'Menurut UU 6/2011 tentang Keimigrasian, ini pidana bagi perusahaan dan dapat\n' +
        'berujung deportasi bagi yang bersangkutan.'
      );
    case 'SIM':
      return (
        'SIM yang kedaluwarsa berarti mengemudi tanpa izin. Klaim asuransi kendaraan\n' +
        'dapat ditolak pada kecelakaan pertama, dan tanggung jawabnya jatuh ke perusahaan.'
      );
    case 'SERTIFIKAT':
      return (
        'Sertifikat kompetensi yang kedaluwarsa dapat membatalkan kelayakan pada\n' +
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
