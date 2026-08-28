import { Client } from 'pg';

/**
 * Aliran peristiwa langsung lewat `LISTEN`/`NOTIFY` (PLAN/12 §3).
 *
 * Dipilih menggantikan Socket.IO + Redis Streams yang ada di rancangan
 * microservices. Alasannya bukan kesederhanaan demi kesederhanaan: fanout lintas
 * node baru diperlukan ketika koneksi pengguna dipegang oleh salah satu dari
 * beberapa proses yang tidak saling tahu. Satu proses web tidak punya masalah
 * itu, dan PostgreSQL sudah memegang kedua ujungnya.
 *
 * Yang harus dipahami sebelum memakai berkas ini: **`LISTEN`/`NOTIFY` berada di
 * luar jangkauan Row-Level Security.** Setiap pendengar sebuah kanal menerima
 * setiap pesan di kanal itu. Karena itu kanalnya per tenant — isolasinya ada
 * pada nama kanal, bukan pada penyaringan setelah pesan diterima.
 *
 * Konsekuensi lain yang tidak boleh dilupakan: `LISTEN` menuntut koneksi
 * tersendiri yang dipegang selama aliran hidup, sehingga ia tidak dapat memakai
 * pool Prisma. Itulah alasan batas jumlah aliran ada di bawah.
 */

/** Nama kanal harus sama persis dengan yang dibangun pemicu di basis data. */
export function tenantChannel(tenantId: string): string {
  return `att_${tenantId.replace(/-/g, '')}`;
}

/**
 * Batas jumlah aliran yang hidup bersamaan dalam satu proses.
 *
 * Setiap aliran memegang satu koneksi PostgreSQL sampai ditutup. Tanpa batas,
 * sebuah tab dasbor yang dibuka berulang kali — atau klien yang menyambung
 * ulang tanpa menutup yang lama — akan menghabiskan seluruh koneksi basis data,
 * dan yang berhenti bekerja bukan dasbornya melainkan SELURUH aplikasi.
 */
const MAX_STREAMS = 32;
let active = 0;

export class TooManyStreamsError extends Error {
  constructor() {
    super('Terlalu banyak aliran langsung yang aktif');
    this.name = 'TooManyStreamsError';
  }
}

export interface LiveStream {
  /** Menghentikan langganan dan mengembalikan koneksinya. Aman dipanggil dua kali. */
  close: () => Promise<void>;
}

/**
 * Mendengarkan peristiwa satu tenant.
 *
 * `onEvent` menerima muatan JSON apa adanya dari `pg_notify`. Muatan yang tidak
 * dapat diurai dibuang tanpa menghentikan aliran: satu pesan cacat tidak boleh
 * memutus dasbor yang sedang dilihat orang.
 */
export async function listenTenant(
  tenantId: string,
  onEvent: (payload: unknown) => void,
  onError?: (error: unknown) => void,
): Promise<LiveStream> {
  if (active >= MAX_STREAMS) throw new TooManyStreamsError();

  /**
   * Koneksi memakai peran APLIKASI, bukan pemilik basis data.
   *
   * Versi pertama memakai `DATABASE_URL`, yang terhubung sebagai `hrms_owner` —
   * satu-satunya peran yang dapat menembus RLS dan satu-satunya yang tidak
   * terikat `statement_timeout`. Setiap dasbor langsung yang dibuka karenanya
   * memegang koneksi tanpa batas waktu dengan hak penuh atas seluruh basis data,
   * untuk pekerjaan yang hanya perlu mendengarkan satu kanal.
   *
   * `LISTEN`/`NOTIFY` memang berada di luar jangkauan RLS, sehingga tidak ada
   * kebocoran yang terjadi pada kasus ini. Tetapi hak yang tidak dibutuhkan
   * tidak boleh diambil hanya karena kebetulan tidak berbahaya di jalur yang
   * ada sekarang — jalur berikutnya yang ditambahkan orang lain di berkas ini
   * akan mewarisinya tanpa ada yang memutuskan begitu.
   */
  const connectionString = process.env['DATABASE_URL_APP'] ?? process.env['DATABASE_URL'];
  const client = new Client({ connectionString });
  await client.connect();
  active += 1;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    active -= 1;
    // `end()` dapat melempar bila koneksinya sudah putus dari sisi server.
    // Yang penting di sini hitungannya turun, dan itu sudah terjadi di atas.
    await client.end().catch(() => undefined);
  };

  client.on('error', (error) => {
    onError?.(error);
    void close();
  });

  client.on('notification', (message) => {
    if (!message.payload) return;
    try {
      onEvent(JSON.parse(message.payload));
    } catch {
      // Muatan cacat dibuang. Lihat alasannya di JSDoc.
    }
  });

  // Nama kanal disisipkan lewat `format`, bukan parameter: `LISTEN` tidak
  // menerima parameter terikat. Aman karena namanya dibangun dari UUID yang
  // sudah divalidasi bentuknya, bukan dari masukan bebas.
  const channel = tenantChannel(tenantId);
  if (!/^att_[0-9a-f]{32}$/.test(channel)) {
    await close();
    throw new Error('Nama kanal tidak sah');
  }
  await client.query(`LISTEN "${channel}"`);

  return { close };
}

/** Berapa aliran yang sedang hidup. Untuk pemantauan dan pengujian. */
export function activeStreamCount(): number {
  return active;
}
