import { describe, expect, it } from 'vitest';
import { assessTrust } from '../src/attendance/trust.ts';

/**
 * Penarikan persetujuan tidak boleh menjadi hukuman.
 *
 * Ini bukan kehalusan desain melainkan syarat keabsahan. UU PDP No. 27/2022
 * menuntut persetujuan yang diberikan secara bebas, dan persetujuan yang
 * diberikan untuk menghindari akibat bukan persetujuan bebas.
 *
 * Bila menarik persetujuan lokasi membuat setiap presensi masuk antrean tinjauan
 * HR, karyawan akan menyetujuinya untuk berhenti dipanggil — dan seluruh layar
 * persetujuan menjadi teater yang justru menciptakan risiko hukum, bukan
 * mengurangi. Angka nol pada penalti inilah yang menahan hal itu.
 */
describe('penarikan persetujuan', () => {
  const web = {
    source: 'WEB' as const,
    distanceM: null,
    radiusM: null,
    accuracyM: null,
    maxAccuracyM: null,
    hasPhoto: false,
    clockSkewSeconds: 0,
    mockLocationReported: false,
  };

  it('tidak menurunkan skor ketika bukti hilang karena persetujuan ditarik', () => {
    const ditarik = assessTrust({
      ...web,
      consentWithheld: { location: true, photo: true },
    });

    // Hanya penalti sumber peramban yang tersisa.
    expect(ditarik.score).toBe(85);
    expect(ditarik.needsReview).toBe(false);
  });

  it('tetap menurunkan skor ketika bukti hilang tanpa alasan persetujuan', () => {
    // Pembanding yang membuat uji di atas bermakna: input yang persis sama,
    // hanya tanpa penarikan persetujuan, jatuh di bawah ambang.
    const sekadarTidakAda = assessTrust(web);

    expect(sekadarTidakAda.score).toBe(35);
    expect(sekadarTidakAda.needsReview).toBe(true);
  });

  it('tetap mencatat alasan buktinya tipis', () => {
    // Penalti nol bukan berarti tandanya hilang. Catatan presensi harus tetap
    // jujur tentang mengapa tidak ada koordinat di dalamnya.
    const ditarik = assessTrust({ ...web, consentWithheld: { location: true } });
    const kode = ditarik.flags.map((flag) => flag.code);

    expect(kode).toContain('LOCATION_CONSENT_WITHHELD');
    expect(kode).not.toContain('NO_LOCATION');
    // Foto tidak ditarik, jadi ketiadaannya tetap dihukum seperti biasa.
    expect(kode).toContain('NO_PHOTO');
  });

  it('tidak menaikkan skor melebihi presensi yang buktinya lengkap', () => {
    // Arah yang berbahaya ke sebaliknya: bila menarik persetujuan menghasilkan
    // skor lebih TINGGI daripada memberikannya, sistem akan mendorong orang
    // menarik persetujuan demi skor — sama merusaknya, hanya terbalik.
    const lengkap = assessTrust({
      ...web,
      distanceM: 20,
      radiusM: 150,
      accuracyM: 15,
      maxAccuracyM: 100,
      hasPhoto: true,
    });
    const ditarik = assessTrust({ ...web, consentWithheld: { location: true, photo: true } });

    expect(ditarik.score).toBeLessThanOrEqual(lengkap.score);
  });
});
