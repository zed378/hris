#!/usr/bin/env bash
set -u
B=http://localhost:3100
ROOT=c:/Users/Zed/Documents/Project/hris
J() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(eval('(j=>('+process.argv[1]+'))')(JSON.parse(d)))}catch(e){console.log('<'+d.slice(0,180)+'>')}})" "$1"; }
tok() { curl -s -X POST $B/api/auth/login -H 'content-type: application/json' -d "$1" | J "j.accessToken"; }

OWNER=$(tok '{"tenantCode":"demo","email":"owner@demo.test","password":"DemoPassword123"}')

echo "── 0. Siapkan dua karyawan terhubung akun ─────────────────────"
curl -s -o /dev/null -X POST $B/api/employees -H "authorization: Bearer $OWNER" -H 'content-type: application/json' \
  -d '{"employeeNumber":"PH-001","fullName":"Andi Staf","email":"staff@demo.test","joinDate":"2024-01-01"}'
curl -s -o /dev/null -X POST $B/api/employees -H "authorization: Bearer $OWNER" -H 'content-type: application/json' \
  -d '{"employeeNumber":"PH-002","fullName":"Sari Manajer","email":"manager@demo.test","joinDate":"2024-01-01"}'
echo "   dua karyawan dibuat"

echo
echo "── 1. Buat JPEG berisi EXIF GPS, lalu unggah ──────────────────"
node -e "
const fs=require('fs');
const L=(p)=>{const b=Buffer.alloc(2);b.writeUInt16BE(p.length+2);return b};
const jfif=Buffer.from([0x4a,0x46,0x49,0x46,0,1,1,0,0,1,0,1,0,0]);
const exif=Buffer.concat([Buffer.from('Exif\0\0','ascii'),Buffer.from('GPSLatitude=-6.9147444;GPSLongitude=107.6098111;Make=RahasiaPonsel','ascii')]);
const sos=Buffer.from([1,1,0]);
fs.writeFileSync('$ROOT/tmp-selfie.jpg', Buffer.concat([
  Buffer.from([0xff,0xd8]),
  Buffer.from([0xff,0xe0]),L(jfif),jfif,
  Buffer.from([0xff,0xe1]),L(exif),exif,
  Buffer.from([0xff,0xda]),L(sos),sos,
  Buffer.from([0x12,0x34,0x56,0x78]),
  Buffer.from([0xff,0xd9]),
]));
console.log('   berkas uji dibuat, berisi: GPSLatitude, Make');
"

STAFF=$(tok '{"tenantCode":"demo","email":"staff@demo.test","password":"DemoPassword123"}')
KEY=$(curl -s -X POST $B/api/attendance/photo -H "authorization: Bearer $STAFF" -F "photo=@$ROOT/tmp-selfie.jpg" | J "j.key")
echo "   diunggah, kunci: ${KEY:0:12}…"

echo
echo "── 2. Berkas TERSIMPAN tidak boleh memuat EXIF ────────────────"
node -e "
const fs=require('fs');
const path='$ROOT/.storage/attendance-photos/${KEY:0:2}/$KEY';
const b=fs.readFileSync(path).toString('latin1');
console.log('   ukuran tersimpan : '+fs.statSync(path).size+' byte');
console.log('   memuat GPSLatitude: '+b.includes('GPSLatitude'));
console.log('   memuat Make       : '+b.includes('Make'));
console.log('   memuat JFIF       : '+b.includes('JFIF')+'  (harus true — berkas tetap sah)');
"

echo
echo "── 3. Presensi dengan foto: skor harus naik ───────────────────"
curl -s -X POST $B/api/attendance/punch -H "authorization: Bearer $STAFF" -H 'content-type: application/json' \
  -d "{\"type\":\"IN\",\"punchedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"latitude\":-6.1753924,\"longitude\":106.8271528,\"accuracyM\":20,\"photoKey\":\"$KEY\",\"dedupeKey\":\"photo-$(date +%s)\"}" \
  | J "'   dengan foto : skor='+j.trustScore+' tinjauan='+j.needsReview"

curl -s -X POST $B/api/attendance/punch -H "authorization: Bearer $STAFF" -H 'content-type: application/json' \
  -d "{\"type\":\"OUT\",\"punchedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"latitude\":-6.1753924,\"longitude\":106.8271528,\"accuracyM\":20,\"dedupeKey\":\"nophoto-$(date +%s)\"}" \
  | J "'   tanpa foto  : skor='+j.trustScore+' tinjauan='+j.needsReview"

echo
echo "── 4. Otorisasi foto ──────────────────────────────────────────"
echo -n "   pemilik foto (harus 200)      : "
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$B/api/attendance/photo/$KEY" -H "authorization: Bearer $STAFF"

MANAGER=$(tok '{"tenantCode":"demo","email":"manager@demo.test","password":"DemoPassword123"}')
echo -n "   karyawan lain (harus 403)     : "
curl -s -o /tmp/r -w "HTTP %{http_code} " "$B/api/attendance/photo/$KEY" -H "authorization: Bearer $MANAGER"
cat /tmp/r | J "j.error.code"

echo -n "   HR peninjau (harus 200)       : "
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$B/api/attendance/photo/$KEY" -H "authorization: Bearer $OWNER"

echo -n "   header cache (harus no-store) : "
curl -s -D - -o /dev/null "$B/api/attendance/photo/$KEY" -H "authorization: Bearer $OWNER" | grep -i "cache-control" | tr -d '\r'

echo
echo "── 5. Kunci berbahaya ditolak ─────────────────────────────────"
echo -n "   path traversal (harus 404/400): "
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$B/api/attendance/photo/..%2F..%2Fpackage.json" -H "authorization: Bearer $OWNER"

echo
echo "── 6. Retensi: majukan kedaluwarsa lalu jalankan job ──────────"
docker exec hrms-postgres psql -U hrms_owner -d hrms -q -c \
  "UPDATE attendance.punch_logs SET photo_expires_at = now() - interval '1 day' WHERE photo_key IS NOT NULL" >/dev/null 2>&1
(cd "$ROOT/apps/worker" && node --experimental-transform-types -e "
import('./photo-retention-once.ts').catch(async () => {
  const { config } = await import('dotenv');
  config({ path: '../../.env', quiet: true });
  const m = await import('./src/photo-retention.ts');
  const db = await import('@hrms/db');
  console.log('   ' + JSON.stringify(await m.runPhotoRetention()));
  await db.disconnectAll();
});
" 2>&1 | grep -v "^(node\|^Warning\|Use \|Cannot find" | head -3)

echo -n "   berkas masih ada? "
node -e "
const fs=require('fs');
console.log(fs.existsSync('$ROOT/.storage/attendance-photos/${KEY:0:2}/$KEY') ? 'YA (salah)' : 'TIDAK (benar)');
"
docker exec hrms-postgres psql -U hrms_owner -d hrms -tAc \
  "SELECT '   catatan presensi tersisa: '||count(*)||'  (harus tetap ada)' FROM attendance.punch_logs"
docker exec hrms-postgres psql -U hrms_owner -d hrms -tAc \
  "SELECT '   masih punya photo_key    : '||count(*)||'  (harus 0)' FROM attendance.punch_logs WHERE photo_key IS NOT NULL"

rm -f "$ROOT/tmp-selfie.jpg"
