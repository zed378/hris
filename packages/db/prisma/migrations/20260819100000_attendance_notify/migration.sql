-- Pemberitahuan presensi langsung (PLAN/12 §3: SSE + LISTEN/NOTIFY).
--
-- Kanalnya PER TENANT, dan itu keputusan keamanan, bukan penamaan.
--
-- `LISTEN`/`NOTIFY` berada di luar jangkauan Row-Level Security: siapa pun yang
-- mendengarkan sebuah kanal menerima setiap pesan yang dikirim ke kanal itu,
-- tanpa satu pun kebijakan RLS ikut dievaluasi. Satu kanal bersama akan
-- mengirimkan aktivitas presensi seluruh tenant kepada setiap proses yang
-- mendengarkan, dan satu-satunya yang mencegah kebocoran adalah penyaringan di
-- sisi aplikasi — yaitu tepat jenis penjagaan yang gagal diam-diam.
--
-- Dengan kanal per tenant, salah dengar berarti tidak mendengar apa-apa.
--
-- Nama kanal adalah identifier PostgreSQL, batasnya 63 karakter.
-- 'att_' + 32 digit heksadesimal UUID = 36 karakter.

CREATE OR REPLACE FUNCTION attendance.notify_punch() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  channel text;
  body    text;
BEGIN
  channel := 'att_' || replace(NEW.tenant_id::text, '-', '');

  -- Muatan TIDAK membawa koordinat maupun rujukan foto.
  --
  -- Aturan PR8 dokumen 10: konsumen hilir menerima status dan tanda saja.
  -- Dasbor langsung adalah konsumen hilir, dan ia tidak membutuhkan koordinat
  -- untuk menampilkan siapa yang sudah masuk. Mengirimkannya "karena mudah"
  -- adalah bagaimana pembatasan tujuan berhenti berlaku tanpa ada yang memutuskan.
  body := json_build_object(
    'id',          NEW.id,
    'employeeId',  NEW.employee_id,
    'type',        NEW.type,
    'source',      NEW.source,
    'punchedAt',   to_char(NEW.punched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'workDate',    to_char(NEW.work_date, 'YYYY-MM-DD'),
    'trustScore',  NEW.trust_score,
    'review',      NEW.review,
    'workSiteId',  NEW.work_site_id
  )::text;

  -- Batas muatan NOTIFY adalah 8000 byte. Muatan di atas sengaja kecil dan
  -- berukuran tetap, jadi batas itu tidak dapat tercapai — tetapi pemeriksaannya
  -- tetap ada supaya penambahan kolom kelak gagal di sini, bukan di produksi.
  IF octet_length(body) < 7000 THEN
    PERFORM pg_notify(channel, body);
  END IF;

  RETURN NULL;
END;
$$;

-- AFTER, dan tanpa nilai balik yang berarti: pemberitahuan tidak boleh mengubah
-- atau menggagalkan penyimpanan presensi. Presensi yang tercatat tetapi tidak
-- terkirim ke dasbor hanyalah dasbor yang tertinggal; presensi yang gagal
-- tersimpan karena dasbornya bermasalah adalah kehilangan data.
DROP TRIGGER IF EXISTS trg_notify_punch ON attendance.punch_logs;
CREATE TRIGGER trg_notify_punch
  AFTER INSERT OR UPDATE OF review, trust_score ON attendance.punch_logs
  FOR EACH ROW EXECUTE FUNCTION attendance.notify_punch();

-- Fungsi berjalan dengan hak pemanggil, bukan SECURITY DEFINER. Ia tidak
-- membaca apa pun di luar baris yang memicunya, sehingga tidak ada alasan
-- menaikkan haknya — dan setiap SECURITY DEFINER baru harus dibenarkan
-- terhadap daftar lima pengecualian terdaftar.
GRANT EXECUTE ON FUNCTION attendance.notify_punch() TO hrms_app, hrms_worker;
