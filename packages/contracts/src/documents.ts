/**
 * Jenis dokumen karyawan.
 *
 * Berada di `contracts`, bukan di `core`, karena layar unggah dokumen adalah
 * komponen klien: mengimpornya dari `core` akan menarik Prisma ke dalam bundel
 * peramban. Sebelum ini, daftarnya ditulis tangan di TIGA tempat — CHECK
 * constraint di basis data, `DOCUMENT_KINDS` di core, dan sebuah array di
 * halaman unggah — dan ketiganya sudah sempat berbeda: 'KITAS' hanya ada di
 * kepala orang yang membutuhkannya.
 *
 * Kini dua: konstanta ini dan constraint basis data. Uji di
 * `packages/db/test/document-kinds.test.ts` membandingkan keduanya terhadap
 * katalog PostgreSQL, sehingga menambah jenis di satu tempat saja menggagalkan
 * CI alih-alih menghasilkan 500 pada unggahan pertama.
 *
 * Urutannya bukan alfabet: identitas dulu, lalu perizinan yang berumur, lalu
 * sisanya — mengikuti urutan orang mengunggahnya.
 */
export const DOCUMENT_KINDS = [
  'KTP',
  'KK',
  'NPWP',
  'IJAZAH',
  /**
   * Perizinan yang berumur.
   *
   * Ditambahkan saat pengingat kedaluwarsa dibangun. Sebelumnya kolom
   * `expiresAt` hanya dapat diisi untuk KONTRAK dan SERTIFIKAT — sehingga KITAS
   * yang lewat, yang berarti tenaga kerja asing bekerja tanpa izin dan pidana
   * bagi perusahaan menurut UU 6/2011, hanya dapat disimpan sebagai 'LAINNYA'.
   * Sebagai 'LAINNYA' ia tidak dapat dibedakan dari fotokopi apa pun.
   */
  'KITAS',
  'IMTA',
  'SIM',
  'KONTRAK',
  'SERTIFIKAT',
  'LAINNYA',
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
