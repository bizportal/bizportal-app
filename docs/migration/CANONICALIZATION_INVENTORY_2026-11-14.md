# Inventaris migrasi BizPortal ke repository canonical

Tanggal pemeriksaan: 14 November 2026 (WIB). Dokumen ini adalah **inventaris dan release gate**, bukan izin mengganti runtime atau menyalin seluruh repository.

## Keputusan sumber kode

- **Sumber pengembangan yang dituju:** `bizportal/bizportal-app`.
- **Sumber historis untuk diperiksa saja:** `Travelintrips/CST-BIZPORTAL` dan `Travelintrips/bizportal-hostinger-mirror`.
- **Jangan merge, force-push, reset, atau mengganti remote PROD/DEV dari dokumen ini.** Pemindahan perubahan harus selektif lewat PR baru di repository canonical, dengan pengujian ulang.
- Git history migrasi dimulai dari snapshot `cd9a94dc39be3322248ddc53ca2bd0b5e53134db` (16 Oktober 2026), menurut `MIGRATION_NOTES.md`; perubahan belakangan tidak otomatis terikut.
- Kondisi saat audit: branch `develop` berbeda dari `main` (GitHub compare: ahead 2, behind 30 terhadap main). Perlakukan keduanya sebagai cabang berbeda sampai rekonsiliasi tervalidasi.

## Inventaris kelompok perubahan

| Kelompok | Bukti di canonical | Sumber historis yang perlu dibandingan | Status / keputusan |
| --- | --- | --- | --- |
| Kop surat Corporate Elegance | [canonical PR #6](https://github.com/bizportal/bizportal-app/pull/6), 1 file, CI pernah SUCCESS | [CST-BIZPORTAL #312](https://github.com/Travelintrips/CST-BIZPORTAL/pull/312), [mirror #164](https://github.com/Travelintrips/bizportal-hostinger-mirror/pull/164) | **Kode editor sudah dipindahkan**; masih perlu membuktikan PDF/Save/Reload E2E dan renderer terpisah |
| Payroll Multi Company | [canonical PR #4](https://github.com/bizportal/bizportal-app/pull/4) sudah merged | [CST-BIZPORTAL #308](https://github.com/Travelintrips/CST-BIZPORTAL/pull/308), [#310](https://github.com/Travelintrips/CST-BIZPORTAL/pull/310) | **Sebagian sudah masuk**; perlu perbandingan perilaku dan progres master gaji, role-scoped read-only |
| Vendor Invoice/AP | [canonical PR #5](https://github.com/bizportal/bizportal-app/pull/5) draft | [CST-BIZPORTAL #304](https://github.com/Travelintrips/CST-BIZPORTAL/pull/304), [#305](https://github.com/Travelintrips/CST-BIZPORTAL/pull/305) | **Belum release**; verifikasi single-writer, idempotency, ERP/GL gate |
| Gmail Invoice | [canonical PR #7](https://github.com/bizportal/bizportal-app/pull/7) merged ke develop | [CST-BIZPORTAL #307](https://github.com/Travelintrips/CST-BIZPORTAL/pull/307), [mirror #166](https://github.com/Travelintrips/bizportal-hostinger-mirror/pull/166), [#172](https://github.com/Travelintrips/bizportal-hostinger-mirror/pull/172) | **Ada perubahan canonical**; perlu audit kelengkapan proteksi kuota, anti-duplikasi, isolasi DEV/PROD |
| OTP/Auth DEV | Belum dibuktikan setara pada canonical | [CST-BIZPORTAL #313](https://github.com/Travelintrips/CST-BIZPORTAL/pull/313), [#314](https://github.com/Travelintrips/CST-BIZPORTAL/pull/314), [#315](https://github.com/Travelintrips/CST-BIZPORTAL/pull/315) | **Prioritas tinggi**, tetapi jangan salin auth tanpa uji sesi, logout, role, RLS |
| Customer AR/bank reconciliation | Belum dibuktikan setara pada canonical | [CST-BIZPORTAL #309](https://github.com/Travelintrips/CST-BIZPORTAL/pull/309), [mirror #169](https://github.com/Travelintrips/bizportal-hostinger-mirror/pull/169), [#170](https://github.com/Travelintrips/bizportal-hostinger-mirror/pull/170) | **Perlu rekonsiliasi kode**; pastikan company-scope fail-closed dan preview read-only |
| Customer Invoice canonical writer | Belum dibuktikan setara pada canonical | [mirror #171](https://github.com/Travelintrips/bizportal-hostinger-mirror/pull/171) | **Perlu analisis kontrak**; tidak boleh membuat penulis invoice/jurnal kedua |
| Document Template API + PDF | Canonical PR #6 hanya editor preview | [mirror #162](https://github.com/Travelintrips/bizportal-hostinger-mirror/pull/162), [#163](https://github.com/Travelintrips/bizportal-hostinger-mirror/pull/163), [#156](https://github.com/Travelintrips/bizportal-hostinger-mirror/pull/156) | **Belum complete**; periksa handler yang benar-benar di-mount di runtime, lalu E2E Super Admin / A4 PDF |
| QRIS + HRD | Belum dibandingkan menyeluruh | [CST-BIZPORTAL #306](https://github.com/Travelintrips/CST-BIZPORTAL/pull/306), [#299](https://github.com/Travelintrips/CST-BIZPORTAL/pull/299) | **Perlu matriks parity**; jangan mengubah transaksi atau master tanpa bukti |

Status di atas menyatakan **bukti yang tersedia saat audit**, bukan klaim semua fitur berjalan di Hostinger.

## Fakta deployment yang perlu dipertahankan sebelum cutover

Audit VPS DEV sebelumnya menunjukkan:
- `/opt/cst-bizportal-gmail-dev` → remote `https://github.com/Travelintrips/CST-BIZPORTAL.git`, branch `develop`, HEAD `023fc93`, working tree mengandung perubahan.
- Nginx DEV `bizportal-dev.cstlogistic.co.id` → frontend `/opt/cst-bizportal-gmail-dev/dist/public`, API `127.0.0.1:19784`; basic authentication aktif.
- `/opt/bizportal-official-vendor-ap-dev-20261114` adalah checkout terpisah dengan remote canonical; **bukan bukti sumber runtime DEV yang aktif**.
- Sumber deployment Hostinger PROD **belum diverifikasi**. Jangan menyimpulkannya hanya dari `git remote` suatu checkout atau PASS GitHub Actions.

## Temuan perbandingan awal yang perlu ditindaklanjuti

- Di canonical `develop`, `artifacts/api-server/src/routes/local-production-auth.ts` **sudah** menggunakan `values ($1, $2, $3, $4, $5)` untuk INSERT OTP; jangan menyalin PR lama #313 secara membabi buta.
- Masih perlu audit kontrak parameter query gabungan: klausa invalidasi OTP memakai `purpose = $2`, sedangkan array parameter INSERT memakai urutan `[email, requestIp, EMAIL_OTP_PURPOSE, ...]`. Ini merupakan **indikasi mismatch** yang harus dibuktikan dengan tes sebelum perubahan kode; jangan mengklaim OTP E2E PASS.
- Source DEV aktif pada VPS masih bukan repository canonical; tidak boleh mengganti origin atau deployment sebelum review working tree dan rollback.

## Urutan pekerjaan wajib (no rebuild)

1. **Baseline aman dan read-only:** ambil bukti versi git, proses runtime, konfigurasi routing tanpa secrets, daftar endpoint, database/schema relevan, backup/rollback point, daftar fitur yang telah PASS. Dilarang menimpa working tree aktif.
2. **Inventory per modul:** bandingkan perubahan _file-by-file_ berdasarkan isi dan perilaku, tandai `already_present`, `missing`, `conflict`, `superseded`, dan `unsafe`.
3. **Migrasi satu workstream per PR canonical**: prioritas auth dan invoice/AP DEV; setiap PR memiliki sumber historis, tes, regression gate, flag OFF by default bila menyentuh financial writes.
4. **DEV parity:** jalankan unit, typecheck, build, API smoke, signed-auth dan company-scope, read/write/read sesuai izin, transaksi sandbox, idempotency; untuk dokumen wajib HTML A4/PDF runtime (bukan contoh terpisah).
5. **Cutover DEV:** hanya setelah DEV canonical terbukti setara dengan baseline layanan aktif; gunakan release artefact + pinned SHA + rollback, jangan langsung mengganti remote checkout yang memiliki perubahan lokal.
6. **Cutover PROD:** identifikasi sumber Hostinger PROD yang benar, bukti rollback, sign-off dan monitoring; jangan membawa payroll posting, invoice posting, QRIS, atau scheduler yang belum PASS.

## Gate wajib pada setiap PR migrasi

- Sumber repo benar: `bizportal/bizportal-app`; target branch dan release channel eksplisit.
- Selisih perubahan terkendali; tidak ada `*.env`, secrets, database dump, PII, hasil OCR atau transaksi nyata.
- Ada bukti CI **pada repository canonical** dan hasil uji E2E DEV untuk alur yang diubah.
- Semua fitur berstatus PASS sebelumnya tetap PASS; tidak membuat duplikasi invoice, jurnal, pembayaran, worker, atau webhook.
- DEV tidak boleh memodifikasi PROD; jika ada migrasi database, gunakan forward migration dan validasi RLS/akses.
- Pengalihan Hostinger harus dibuktikan dari sumber deploy aktif, bukan asumsi dari nama repo.
- PR yang belum memenuhi gate tetap DRAFT. Tidak ada auto-merge ke `main`/PROD.

**Catatan:** Daftar ini belum mencakup setiap PR historis; perlu diperluas melalui inventaris paginasi/commit dan source-vs-runtime parity sebelum menyatakan migrasi menyeluruh selesai.
