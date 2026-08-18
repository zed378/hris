import { hash, verify } from '@node-rs/argon2';

/**
 * Parameter argon2id.
 *
 * Mengikuti profil yang direkomendasikan OWASP: memori 19 MiB, dua iterasi,
 * paralelisme satu. Memori adalah pengungkit terpenting di sini — ia yang membuat
 * serangan GPU mahal, dan iterasi tinggi dengan memori rendah tidak menggantikannya.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(plain: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain, ARGON2_OPTIONS);
  } catch {
    // Hash rusak atau berformat asing. Diperlakukan sebagai gagal, bukan dilempar:
    // satu baris rusak tidak boleh membedakan responsnya dari kata sandi salah.
    return false;
  }
}

/**
 * Hash pengalih waktu untuk pengguna yang tidak ada.
 *
 * Tanpa ini, login untuk email yang tidak terdaftar kembali seketika sementara
 * email terdaftar memakan ~50 ms argon2 — selisih yang cukup untuk mencacah
 * alamat email yang sah. Dipanggil di jalur "pengguna tidak ditemukan" agar biaya
 * waktunya setara.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Yr6mUW2h2cvJ2iRUEZ8YQ5xnBPUQMBGEyqUKbUcHnkI';

export async function burnTimingBudget(candidate: string): Promise<void> {
  await verifyPassword(candidate, DUMMY_HASH);
}
