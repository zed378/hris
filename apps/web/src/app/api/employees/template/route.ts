import writeXlsxFile from 'write-excel-file/node';
import { EMPLOYEE_COLUMNS } from '@hrms/core/employee';
import { defineRoute } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Templat impor.
 *
 * Berisi judul kolom yang dikenali plus dua baris contoh. Baris contoh itu yang
 * paling sering menentukan berhasil tidaknya percobaan pertama: judul kolom
 * memberi tahu apa yang diminta, contoh memberi tahu bentuknya.
 *
 * Format tanggal dinyatakan terbuka di sini, bukan diserahkan pada tebakan
 * pengurai. "03/04/2024" sah dalam dua tafsir, dan menebak salah menggeser
 * tanggal masuk seseorang tiga puluh hari tanpa satu pun galat.
 */
export const GET = defineRoute('GET /api/employees/template', async () => {
  const header = EMPLOYEE_COLUMNS.map((column) => ({
    value: column.required ? `${column.label} *` : column.label,
    fontWeight: 'bold' as const,
    backgroundColor: '#E8EEF9',
  }));

  const sample = (values: Record<string, string>) =>
    EMPLOYEE_COLUMNS.map((column) => ({ value: values[column.field] ?? '', type: String }));

  const rows = [
    header,
    sample({
      employeeNumber: 'EMP-0001',
      fullName: 'Siti Rahayu',
      nationalId: '3201123456789012',
      taxId: '09.254.294.3-407.000',
      email: 'siti@perusahaan.co.id',
      phone: '081234567890',
      joinDate: '01/03/2024',
      birthDate: '15/08/1995',
      birthPlace: 'Bandung',
      gender: 'P',
      bankName: 'BCA',
      bankAccount: '1234567890',
      address: 'Jl. Merdeka No. 10, Bandung',
    }),
    sample({
      employeeNumber: 'EMP-0002',
      fullName: 'Budi Santoso',
      joinDate: '15/01/2023',
      gender: 'L',
    }),
    // Baris penjelas. Sengaja diletakkan sebagai data, bukan sebagai komentar
    // sel: komentar tidak terlihat saat berkas dibuka di Google Sheets atau
    // LibreOffice, dan sebagian pelanggan memakai keduanya.
    EMPLOYEE_COLUMNS.map((column, index) => ({
      value:
        index === 0
          ? 'HAPUS BARIS INI — Kolom bertanda * wajib diisi. Tanggal: hari/bulan/tahun (01/03/2024). Jenis kelamin: L atau P.'
          : '',
      type: String,
      color: '#B45309',
    })),
  ];

  const buffer = await writeXlsxFile(rows as never, {
    sheet: 'Data Karyawan',
    columns: EMPLOYEE_COLUMNS.map((column) => ({
      width: column.field === 'address' ? 40 : column.field === 'fullName' ? 24 : 18,
    })),
  }).toBuffer();

  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="templat-impor-karyawan.xlsx"',
      // Templat berubah bersama daftar kolom, dan daftar kolom berubah bersama
      // deploy. Tidak di-cache agar pelanggan tidak mengunduh templat versi lama
      // lalu bingung mengapa kolom barunya ditolak.
      'cache-control': 'no-store',
    },
  });
});
