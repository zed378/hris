import { readFileSync, writeFileSync } from 'node:fs';

const p = 'packages/core/src/attendance/photo.ts';
const raw = readFileSync(p, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
let s = raw.split('\r\n').join('\n');

// 1. Impor untuk resolusi akar yang stabil.
s = s.replace(
  "import { dirname, join, resolve } from 'node:path';",
  [
    "import { fileURLToPath } from 'node:url';",
    "import { dirname, isAbsolute, join, resolve } from 'node:path';",
  ].join('\n'),
);

// 2. storageRoot yang tidak bergantung pada CWD.
const oldRoot = [
  'function storageRoot(): string {',
  "  return resolve(process.env['PHOTO_STORAGE_DIR'] ?? './.storage/attendance-photos');",
  '}',
].join('\n');

const newRoot = [
  '/**',
  ' * Akar penyimpanan foto.',
  ' *',
  ' * Path relatif diselesaikan terhadap akar repositori, BUKAN terhadap direktori',
  ' * kerja proses. Perbedaannya bukan kerapian: `apps/web` dan `apps/worker`',
  ' * berjalan dari direktori yang berbeda, sehingga path relatif membuat keduanya',
  ' * menunjuk tempat yang berlainan — web menulis foto di satu tempat, job retensi',
  ' * mencarinya di tempat lain.',
  ' *',
  ' * Kegagalannya tidak terlihat: job melaporkan berhasil menghapus, rujukan di',
  ' * basis data dibersihkan, dan berkasnya tetap ada di disk selamanya. Janji',
  ' * retensi 90 hari batal tanpa satu pun galat.',
  ' */',
  'function storageRoot(): string {',
  "  const configured = process.env['PHOTO_STORAGE_DIR'] ?? './.storage/attendance-photos';",
  '  if (isAbsolute(configured)) return configured;',
  '',
  '  // packages/core/src/attendance/photo.ts → naik lima tingkat ke akar repositori.',
  '  const here = dirname(fileURLToPath(import.meta.url));',
  "  return resolve(here, '../../../..', configured);",
  '}',
].join('\n');

if (!s.includes(oldRoot)) throw new Error('storageRoot tidak ditemukan');
s = s.replace(oldRoot, newRoot);

// 3. deletePhoto membedakan "sudah tidak ada" dari kegagalan lain.
const oldDelete = [
  'export async function deletePhoto(key: string): Promise<void> {',
  '  // Kegagalan diabaikan: berkas yang sudah tidak ada adalah keadaan yang',
  '  // diinginkan, dan job pembersihan tidak boleh berhenti karena satu berkas',
  '  // sudah terhapus lebih dulu.',
  '  await unlink(pathFor(key)).catch(() => undefined);',
  '}',
].join('\n');

const newDelete = [
  'export interface DeleteOutcome {',
  '  /** Berkas benar-benar dihapus pada pemanggilan ini. */',
  '  removed: boolean;',
  '  /** Berkas memang sudah tidak ada. Bukan galat. */',
  '  alreadyGone: boolean;',
  '}',
  '',
  '/**',
  ' * Menghapus berkas foto.',
  ' *',
  ' * Membedakan "sudah tidak ada" dari "gagal dihapus", dan itu perbedaan yang',
  ' * menanggung beban. Versi pertama menelan seluruh galat, sehingga berkas yang',
  ' * TIDAK DITEMUKAN — karena path penyimpanannya salah — dilaporkan sebagai',
  ' * berhasil dihapus. Job retensi terlihat bekerja sempurna sementara setiap foto',
  ' * yang pernah diunggah masih tersimpan di disk.',
  ' *',
  ' * Kegagalan selain berkas-tidak-ada dilempar, supaya pemanggil dapat',
  ' * menghitungnya dan TIDAK menghapus rujukannya di basis data. Rujukan yang',
  ' * bertahan adalah satu-satunya cara putaran berikutnya menemukan berkas itu lagi.',
  ' */',
  'export async function deletePhoto(key: string): Promise<DeleteOutcome> {',
  '  try {',
  '    await unlink(pathFor(key));',
  '    return { removed: true, alreadyGone: false };',
  '  } catch (error) {',
  "    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {",
  '      return { removed: false, alreadyGone: true };',
  '    }',
  '    throw error;',
  '  }',
  '}',
].join('\n');

if (!s.includes(oldDelete)) throw new Error('deletePhoto tidak ditemukan');
s = s.replace(oldDelete, newDelete);

writeFileSync(p, s.split('\n').join(eol));
console.log('photo: akar penyimpanan stabil, penghapusan melaporkan hasilnya');
