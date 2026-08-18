#!/usr/bin/env bash
set -u
B=http://localhost:3100
J() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(eval('(j=>('+process.argv[1]+'))')(JSON.parse(d)))}catch(e){console.log('<'+d.slice(0,200)+'>')}})" "$1"; }
tok() { curl -s -X POST $B/api/auth/login -H 'content-type: application/json' -d "$1" | J "j.accessToken"; }
psql() { docker exec hrms-postgres psql -U hrms_owner -d hrms -tAc "$1"; }

OWNER=$(tok '{"tenantCode":"demo","email":"owner@demo.test","password":"DemoPassword123"}')
STAFF=$(tok '{"tenantCode":"demo","email":"staff@demo.test","password":"DemoPassword123"}')
EMP=$(curl -s "$B/api/employees?limit=5" -H "authorization: Bearer $OWNER" | J "j.employees.find(e=>e.employeeNumber==='PH-001').id")
echo "karyawan uji: $EMP"

manual() { # $1=tanggal $2=jam $3=alasan $4=tipe
  curl -s -w '\nHTTP %{http_code}' -X POST $B/api/attendance/manual-punch \
    -H "authorization: Bearer $OWNER" -H 'content-type: application/json' \
    -d "{\"employeeId\":\"$EMP\",\"type\":\"${4:-IN}\",\"punchedAt\":\"${1}T${2}:00:00.000Z\",\"reason\":\"$3\"}"
}

echo
echo "── 1. Alasan wajib — tanpa alasan harus 400 ───────────────────"
curl -s -o /dev/null -w "   tanpa alasan : HTTP %{http_code}\n" -X POST $B/api/attendance/manual-punch \
  -H "authorization: Bearer $OWNER" -H 'content-type: application/json' \
  -d "{\"employeeId\":\"$EMP\",\"type\":\"IN\",\"punchedAt\":\"2026-08-10T01:00:00.000Z\"}"

echo
echo "── 2. Karyawan biasa tidak boleh mengetuk atas nama orang lain ─"
curl -s -o /dev/null -w "   staf biasa   : HTTP %{http_code}  (harus 403)\n" -X POST $B/api/attendance/manual-punch \
  -H "authorization: Bearer $STAFF" -H 'content-type: application/json' \
  -d "{\"employeeId\":\"$EMP\",\"type\":\"IN\",\"punchedAt\":\"2026-08-10T01:00:00.000Z\",\"reason\":\"mencoba\"}"

echo
echo "── 3. Entri manual yang sah ───────────────────────────────────"
manual 2026-08-10 01 "Lupa absen, dikonfirmasi atasan" IN | tail -2 | tr '\n' ' '; echo
manual 2026-08-10 10 "Lupa absen pulang" OUT | tail -2 | tr '\n' ' '; echo

echo
echo "── 4. TIDAK boleh masuk antrean tinjauan HR ───────────────────"
psql "SELECT '   review='||review||'  skor='||trust_score||'  catatan='||coalesce(review_note,'-')
      FROM attendance.punch_logs WHERE source='MANUAL' ORDER BY created_at DESC LIMIT 2"
psql "SELECT '   antrean NEEDS_REVIEW bersumber MANUAL: '||count(*)||'  (harus 0)'
      FROM attendance.punch_logs WHERE source='MANUAL' AND review='NEEDS_REVIEW'"

echo
echo "── 5. Jejak audit memuat siapa dan alasannya ──────────────────"
psql "SELECT '   '||action||'  alasan=\"'||coalesce(after->>'reason','(tidak ada)')||'\"'
      FROM audit.audit_logs WHERE action='attendance.punch.manual_entry' ORDER BY created_at DESC LIMIT 2"

echo
echo "── 6. Klik ganda tidak menggandakan baris ─────────────────────"
manual 2026-08-10 01 "Lupa absen, dikonfirmasi atasan" IN | tail -2 | tr '\n' ' '; echo "  ← kunci sama"
psql "SELECT '   baris MANUAL pada 2026-08-10: '||count(*)||'  (harus 2, bukan 3)'
      FROM attendance.punch_logs WHERE source='MANUAL' AND work_date='2026-08-10'"

echo
echo "── 7. Rekap hariannya benar-benar terbentuk ───────────────────"
curl -s "$B/api/attendance/records?from=2026-08-10&to=2026-08-10" -H "authorization: Bearer $OWNER" \
  | J "j.days.map(d=>'   '+d.workDate+' '+d.status+' masuk='+(d.checkIn||'-')+' kerja='+d.workMinutes+'m terkunci='+d.isLocked).join('\n')"

echo
echo "── 8. Periode ditutup → koreksi ditolak 409, bukan diam ───────"
curl -s -o /dev/null -w "   tutup periode 08/2026 : HTTP %{http_code}\n" -X POST $B/api/attendance/records \
  -H "authorization: Bearer $OWNER" -H 'content-type: application/json' \
  -d '{"action":"close-period","year":2026,"month":8}'
manual 2026-08-11 02 "Koreksi setelah periode ditutup" IN | tail -2 | tr '\n' ' '; echo
curl -s -X POST $B/api/attendance/manual-punch -H "authorization: Bearer $OWNER" -H 'content-type: application/json' \
  -d "{\"employeeId\":\"$EMP\",\"type\":\"IN\",\"punchedAt\":\"2026-08-11T02:00:00.000Z\",\"reason\":\"Koreksi setelah periode ditutup\"}" \
  | J "'   pesan: '+j.error.message"
psql "SELECT '   baris MANUAL pada 2026-08-11: '||count(*)||'  (harus 0 — tidak diam-diam tersimpan)'
      FROM attendance.punch_logs WHERE source='MANUAL' AND work_date='2026-08-11'"

echo
echo "── 9. Ketukan WEB terlambat TETAP dicatat meski periode tutup ──"
curl -s -X POST $B/api/attendance/punch -H "authorization: Bearer $STAFF" -H 'content-type: application/json' \
  -d "{\"type\":\"IN\",\"punchedAt\":\"2026-08-12T02:00:00.000Z\",\"dedupeKey\":\"luring-$(date +%s%N)\"}" \
  | J "'   ketukan luring: skor='+j.trustScore+' tersimpan='+(j.id?'ya':'tidak')"
psql "SELECT '   rekap 2026-08-12 berubah? '||coalesce((SELECT is_locked::text FROM attendance.attendance_days WHERE work_date='2026-08-12' LIMIT 1),'belum ada baris')"
