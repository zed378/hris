#!/usr/bin/env node
/**
 * Membangkitkan sepasang kunci VAPID untuk Web Push.
 *
 *   node ops/scripts/generate-vapid.mjs
 *
 * Kunci ini menandatangani permintaan ke layanan push peramban (FCM, Mozilla,
 * Apple). Ia BUKAN kunci enkripsi payload — payload dienkripsi dengan kunci
 * milik masing-masing perangkat, dan kunci itu tidak pernah kita bangkitkan.
 *
 * Yang perlu diketahui sebelum menggantinya: mengganti pasangan kunci
 * **membatalkan seluruh langganan yang sudah ada.** Setiap perangkat harus
 * berlangganan ulang, dan tidak ada yang memberi tahu penggunanya — notifikasi
 * hanya berhenti datang. Simpan pasangan ini seperti menyimpan kunci basis
 * data.
 */
import { createRequire } from 'node:module';

// Diselesaikan dari paket core, tempat `web-push` benar-benar terpasang.
// Root repositori tidak memilikinya, dan tidak perlu memilikinya hanya untuk
// satu skrip yang dijalankan sekali seumur instalasi.
const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const webpush = require('web-push');

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log('Salin ke .env:\n');
console.log(`VAPID_PUBLIC_KEY="${publicKey}"`);
console.log(`VAPID_PRIVATE_KEY="${privateKey}"`);
console.log(`VAPID_SUBJECT="mailto:admin@perusahaan-anda.co.id"`);
console.log('\nCATATAN: mengganti pasangan ini membatalkan seluruh langganan');
console.log('         yang sudah ada, dan penggunanya tidak diberi tahu.');
