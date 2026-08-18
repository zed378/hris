/**
 * Pengiriman email.
 *
 * Dua transport, dipilih dari lingkungan. Yang penting bukan pilihannya,
 * melainkan bahwa keduanya memenuhi antarmuka yang sama — sehingga tidak ada
 * satu pun kode pemanggil yang tahu email itu benar-benar terkirim atau hanya
 * tercetak di terminal.
 *
 * `console` adalah default, dan itu disengaja. Lingkungan pengembangan yang
 * diam-diam mengirim email sungguhan ke alamat pelanggan pada berkas seed adalah
 * kesalahan yang hanya dapat dilakukan sekali, dan biayanya tidak sebanding
 * dengan kenyamanan apa pun.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/** Mencetak email ke log alih-alih mengirimkannya. */
class ConsoleTransport implements EmailTransport {
  readonly name = 'console';

  async send(message: EmailMessage): Promise<void> {
    console.log(
      [
        '',
        '┌─ EMAIL (tidak dikirim — transport: console) ─────────────────',
        `│ Kepada : ${message.to}`,
        `│ Subjek : ${message.subject}`,
        '├──────────────────────────────────────────────────────────────',
        ...message.text.split('\n').map((line) => `│ ${line}`),
        '└──────────────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    );
  }
}

/**
 * Resend (PLAN/12 §3.4 — beli, jangan bangun).
 *
 * Menyentuh SMTP sendiri berarti mengelola reputasi IP, SPF, DKIM, DMARC, dan
 * antrean bounce. Semuanya pekerjaan penuh waktu yang tidak ada hubungannya
 * dengan HRIS.
 */
class ResendTransport implements EmailTransport {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });

    if (!response.ok) {
      // Badan respons ikut dibawa: galat Resend menjelaskan sebabnya (domain
      // belum diverifikasi, alamat ditolak), dan status code saja tidak.
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend menolak (${response.status}): ${detail.slice(0, 200)}`);
    }
  }
}

let cached: EmailTransport | null = null;

export function emailTransport(): EmailTransport {
  if (cached) return cached;

  const apiKey = process.env['RESEND_API_KEY'];
  const from = process.env['EMAIL_FROM'];

  // Keduanya harus ada. Kunci tanpa alamat pengirim akan gagal pada setiap
  // pengiriman, dan lebih baik jatuh ke console daripada mengisi antrean dengan
  // kegagalan yang seragam.
  cached =
    apiKey && from ? new ResendTransport(apiKey, from) : new ConsoleTransport();

  return cached;
}

/** Hanya untuk pengujian. */
export function setEmailTransport(transport: EmailTransport | null): void {
  cached = transport;
}
