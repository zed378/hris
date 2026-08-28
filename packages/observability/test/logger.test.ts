import { describe, expect, it } from 'vitest';
import { redact } from '../src/logger.ts';

/**
 * Redaksi log.
 *
 * Yang diuji di sini adalah kebocoran yang tidak menghasilkan galat apa pun.
 * Objek galat yang di-log apa adanya kerap membawa isi permintaan yang
 * menyebabkannya — dan pada sistem ini isi permintaan dapat berupa NIK, nomor
 * rekening, kata sandi, atau token akses.
 *
 * Log dikirim ke agregator, disimpan berbulan-bulan, dan dibaca lebih banyak
 * orang daripada basis datanya sendiri. Kebocoran lewat log hanya menumpuk,
 * diam, sampai seseorang menyadari berkas log memuat persis data yang RLS
 * dijaga mati-matian untuk melindunginya.
 */

const bersih = (value: unknown): string => JSON.stringify(redact(value));

describe('redaksi kunci sensitif', () => {
  it('menyunting kata sandi dalam segala bentuk penamaannya', () => {
    const hasil = bersih({
      password: 'RahasiaBesar123',
      passwordHash: '$argon2id$v=19$...',
      ownerPassword: 'RahasiaLain',
    });
    expect(hasil).not.toContain('RahasiaBesar123');
    expect(hasil).not.toContain('argon2id');
    expect(hasil).not.toContain('RahasiaLain');
  });

  it('menyunting token dan header otorisasi', () => {
    const hasil = bersih({
      accessToken: 'eyJhbGciOi...',
      refreshToken: 'abc123',
      authorization: 'Bearer eyJ...',
      cookie: 'session=xyz',
    });
    for (const bocor of ['eyJhbGciOi', 'abc123', 'Bearer', 'session=xyz']) {
      expect(hasil).not.toContain(bocor);
    }
  });

  it('menyunting PII karyawan', () => {
    // Ketiganya dienkripsi di basis data. Membiarkannya lolos ke log berarti
    // menyimpannya dalam bentuk terbaca di tempat yang tidak dijaga RLS.
    const hasil = bersih({
      nationalId: '3201234567899012',
      taxId: '09.254.294.3-407.000',
      bankAccount: '1234567890',
      employee: { nationalIdEncrypted: 'v1:abc', nik: '3201234567899012' },
    });
    expect(hasil).not.toContain('3201234567899012');
    expect(hasil).not.toContain('09.254.294.3');
    expect(hasil).not.toContain('1234567890');
    expect(hasil).not.toContain('v1:abc');
  });

  it('menyunting kunci penyimpanan berkas', () => {
    // Kunci foto dan dokumen tidak dapat ditebak, dan itu lapisan pertahanan
    // kedua di endpoint penyajiannya. Kunci yang tercecer di log menghapus
    // lapisan itu.
    const hasil = bersih({ photoKey: 'abc-def.jpg', storageKey: 'ghi-jkl.pdf' });
    expect(hasil).not.toContain('abc-def');
    expect(hasil).not.toContain('ghi-jkl');
  });

  it('menyunting berdasarkan nama kunci, bukan bentuk nilainya', () => {
    // Pencocokan berbasis nilai akan meleset pada data yang bentuknya tidak
    // terduga — dan meleset di sini berarti data pribadi masuk agregator log.
    expect(bersih({ nationalId: 12345 })).not.toContain('12345');
    expect(bersih({ nationalId: { nested: 'rahasia' } })).not.toContain('rahasia');
  });

  it('membiarkan medan diagnostik apa adanya', () => {
    // Redaksi yang terlalu luas membuat log tidak berguna. Yang diperlukan
    // untuk mendiagnosis harus tetap terbaca.
    const hasil = bersih({
      scope: 'punch',
      correlationId: 'c-123',
      tenantId: 't-456',
      employeeId: 'e-789',
      trustScore: 65,
    });
    expect(hasil).toContain('punch');
    expect(hasil).toContain('c-123');
    expect(hasil).toContain('t-456');
    expect(hasil).toContain('e-789');
    expect(hasil).toContain('65');
  });
});

describe('perlindungan terhadap muatan yang tidak wajar', () => {
  it('memotong string yang sangat panjang', () => {
    const hasil = redact({ body: 'x'.repeat(5000) }) as { body: string };
    expect(hasil.body.length).toBeLessThan(2100);
    expect(hasil.body).toContain('dipotong');
  });

  it('memotong larik yang sangat panjang', () => {
    // Seribu baris impor yang gagal tidak perlu seluruhnya masuk log untuk
    // dapat didiagnosis.
    const hasil = redact({ rows: Array.from({ length: 500 }, (_, i) => i) }) as {
      rows: unknown[];
    };
    expect(hasil.rows.length).toBe(21);
    expect(String(hasil.rows[20])).toContain('480 lainnya');
  });

  it('berhenti pada struktur yang terlalu dalam', () => {
    let deep: Record<string, unknown> = { nilai: 'dasar' };
    for (let i = 0; i < 20; i += 1) deep = { lapisan: deep };
    expect(bersih(deep)).toContain('terlalu dalam');
  });

  it('tidak macet pada rujukan melingkar', () => {
    const a: Record<string, unknown> = { nama: 'a' };
    a['diri'] = a;
    // Batas kedalaman yang menyelamatkannya, bukan pelacakan rujukan.
    expect(() => bersih(a)).not.toThrow();
  });

  it('mengubah BigInt menjadi string', () => {
    // `JSON.stringify` melempar pada BigInt, dan galat di dalam logger akan
    // menyembunyikan galat yang sedang dicoba dicatat.
    expect(bersih({ id: 123n })).toContain('"123"');
  });
});

describe('penanganan objek galat', () => {
  it('mengambil nama dan pesannya', () => {
    const hasil = redact({ error: new TypeError('sesuatu rusak') }) as {
      error: { name: string; message: string };
    };
    expect(hasil.error.name).toBe('TypeError');
    expect(hasil.error.message).toBe('sesuatu rusak');
  });

  it('menyertakan kode galat basis data bila ada', () => {
    const error = Object.assign(new Error('unique violation'), { code: 'P2002' });
    expect(bersih({ error })).toContain('P2002');
  });
});
