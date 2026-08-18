#!/usr/bin/env node
/**
 * Menghasilkan kode TOTP dari sebuah rahasia — untuk pengujian lokal.
 *
 * Login superuser mewajibkan TOTP, dan mewajibkannya juga berarti alur admin
 * tidak dapat diuji dari skrip tanpa alat ini. Rahasia superuser demo dicetak
 * oleh `pnpm db:seed`.
 *
 *   node ops/scripts/dev-totp.mjs JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP
 */
import { generateSync } from 'otplib';

const secret = process.argv[2];
if (!secret) {
  console.error('Pemakaian: node ops/scripts/dev-totp.mjs <rahasia-base32>');
  process.exit(1);
}

console.log(generateSync({ secret, strategy: 'totp' }));
