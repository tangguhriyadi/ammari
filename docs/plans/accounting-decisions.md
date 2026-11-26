# Keputusan Kebijakan Akuntansi Ammari

Untuk: Ibu (akuntan Ammari)
Dari: tim aplikasi Ammari

**Status: semua 25 keputusan sudah DIPUTUSKAN oleh pemilik dan akuntan pada 26 November 2026.**

Aplikasi Ammari akan dilengkapi pembukuan berpasangan (debit–kredit) sesuai **SAK EMKM**,
**basis akrual**, dalam **rupiah**, dengan periode **bulanan waktu Jakarta**. Jurnal dibuat
otomatis dari data yang sudah dicatat di aplikasi (pesanan, pembayaran, pembelian, produksi,
stok, biaya). Jurnal manual hanya untuk hal yang tidak dicatat aplikasi (modal, prive, aset
tetap, top-up Biteship, pencairan saldo, dan sejenisnya).

Setiap keputusan di bawah ditulis sebagai **aturan** yang berlaku, ditambah satu baris tentang
pilihan yang **tidak dipilih**. Jika suatu saat aturan diubah, perubahan hanya berlaku ke depan;
bulan yang sudah ditutup tidak diubah.

Catatan umum:
- Jurnal **tidak pernah diedit atau dihapus**. Kesalahan dibetulkan dengan jurnal pembalik, lalu
  jurnal yang benar.
- Bulan yang sudah **ditutup** dikunci. Koreksi yang datang belakangan masuk ke bulan pertama yang
  masih terbuka (Keputusan 23).
- Daftar akun (bagan akun) bisa Ibu ubah sendiri: tambah sub-akun, ganti nama, nonaktifkan.
  Akun yang sudah pernah dipakai tidak bisa dihapus. Akun yang dipakai jurnal otomatis bisa
  diganti namanya dan diberi sub-akun, tetapi tidak bisa dinonaktifkan.
- Dua keputusan memerlukan **fitur kecil** di aplikasi, yang dibuat sebelum pembukuan resmi dimulai
  (1 Januari 2027): tanggal kirim asli pesanan marketplace (Keputusan 2) dan pilihan cara bayar
  serta rekening untuk pesanan manual (Keputusan 3).

---

## A. Penjualan

### 1. Kapan penjualan diakui — DIPUTUSKAN

**Aturan:** penjualan dan HPP diakui **saat barang diserahkan ke kurir (dikirim)**. Uang yang
diterima sebelum barang dikirim adalah *Uang muka pelanggan* (kewajiban), belum pendapatan.

- **Website:**
  - saat pembeli membayar: Dr *Piutang Midtrans* / Cr *Uang muka pelanggan*;
  - saat dikirim: Dr *Uang muka pelanggan* / Cr *Penjualan*;
  - saat Midtrans mencairkan dana: Dr *Bank* + Dr *Biaya payment gateway* / Cr *Piutang Midtrans*.
    Bagian biaya payment gateway dicatat pada tanggal pembayaran (lihat Keputusan 8), sehingga saat
    pencairan yang tercatat tinggal uang bersih yang masuk ke bank.
- **Shopee/TikTok:**
  - saat dikirim: Dr *Saldo Penjual* (bersih) + Dr *Beban biaya marketplace* / Cr *Penjualan* (bruto);
  - saat dana ditarik ke bank: Dr *Bank* / Cr *Saldo Penjual*.
- **Semua saluran:** saat dikirim, Dr *HPP* / Cr *Persediaan barang jadi*. (Barang yang sudah
  dibayar tetapi belum dikirim tetap tercatat sebagai persediaan, pada sub-akun *Barang terjual
  belum dikirim*.)

**Tidak dipilih:** pengakuan saat pembeli membayar, atau saat pesanan "Selesai".

### 2. Tanggal pesanan Shopee/TikTok hasil impor — DIPUTUSKAN

**Aturan:** pesanan marketplace diakui pada **tanggal kirim dan tanggal selesai yang sebenarnya,
diambil dari file ekspor** Shopee/TikTok. Aplikasi akan menyimpan kedua tanggal itu saat file
diunggah (fitur kecil). Jika suatu pesanan belum punya tanggal kirim di file, pesanan itu belum
dibukukan dan muncul di daftar "perlu dicek" sampai file terbaru diunggah. Tidak ada aturan batas
unggah tanggal 3.

**Tidak dipilih:** memakai tanggal unggah dengan aturan "unggah paling lambat tanggal 3", atau
memakai tanggal pesan.

### 3. Uang dari pesanan manual (WhatsApp, Instagram, offline) — DIPUTUSKAN

**Aturan:** saat mencatat pesanan manual, staf **memilih cara bayar dan rekening tujuan** untuk
setiap pesanan (fitur kecil). Uang langsung dicatat masuk ke rekening itu sebagai *Uang muka
pelanggan*, lalu menjadi penjualan saat barang dikirim. Pilihan rekening untuk sementara hanya
**Kas tunai** dan **Bank utama** (Keputusan 17). Tidak ada penjualan kredit.

**Tidak dipilih:** akun penampung yang Ibu pindahkan ke kas/bank setiap akhir bulan, atau
menganggap semua uang masuk ke Bank utama.

### 4. Voucher — DIPUTUSKAN

**Aturan:** voucher (voucher kartu terima kasih dan voucher toko yang ditanggung penjual di
marketplace) dicatat sebagai **Potongan penjualan** (mengurangi penjualan) saat dipakai. Tidak ada
jurnal saat voucher dibagikan.

**Tidak dipilih:** voucher sebagai beban promosi.

### 5. Biaya marketplace — DIPUTUSKAN

**Aturan:** komisi, biaya admin, biaya layanan, komisi afiliasi, dan subsidi ongkir penjual
dicatat sebagai **beban penjualan pada tanggal penjualannya**. Jika nilainya berubah saat file
diunggah ulang, selisihnya dicatat di **bulan pertama yang masih terbuka**.

**Tidak dipilih:** biaya sebagai pengurang penjualan, atau dicatat saat dana dicairkan.

### 6. Ongkos kirim pembeli dan subsidi ongkir — DIPUTUSKAN

**Aturan:** ongkir yang dibayar pembeli dicatat sebagai **Titipan ongkir pembeli** (kewajiban,
bukan pendapatan) dan dipakai membayar kurir. Subsidi ongkir website dan subsidi ongkir penjual di
marketplace dicatat sebagai **beban penjualan**.

**Tidak dipilih:** ongkir pembeli sebagai pendapatan ongkos kirim.

### 7. Retur, barang cacat, dan pemakaian pribadi — DIPUTUSKAN

**Aturan:**
- **Retur setelah barang dikirim:** penjualan dibalik melalui *Retur penjualan*; HPP dibalik dan
  barang kembali ke persediaan dengan harga pokok semula. Ongkir yang ikut dikembalikan ke pembeli
  menjadi *Beban ongkos kirim* (kurir sudah dibayar).
- **Barang cacat yang dihibahkan atau dibuang:** *Beban barang cacat dilepas* sebesar nilai
  persediaannya. Akun ini termasuk **beban usaha, bukan HPP** (kelompok *Beban persediaan*,
  bersama *Selisih persediaan* dan *Kerusakan & kehilangan persediaan*; sejalan dengan Keputusan 16).
- **Barang cacat yang dilelang:** nilai persediaannya menjadi *Beban barang cacat dilepas*, dan
  uang hasil lelang dicatat sebagai *Pendapatan lain-lain*.
- **Barang dipakai pribadi:** *Prive* sebesar harga pokoknya.

**Tidak dipilih:** hasil lelang sebagai pengurang beban barang cacat; barang cacat dilepas sebagai
bagian dari HPP.

---

## B. Pembayaran online, kurir, dan saldo platform

### 8. Biaya Midtrans (MDR) — DIPUTUSKAN

**Aturan:** biaya Midtrans dicatat sebagai *Biaya payment gateway* **pada tanggal pembeli
membayar**. Mula-mula berupa **perkiraan** dari tarif per metode bayar (persen + biaya tetap +
PPN, dihitung dari total yang dibayar pembeli **termasuk ongkir**), lalu **diganti dengan biaya
sebenarnya** saat laporan Midtrans diunggah. Jika bulan pembayaran sudah ditutup, selisihnya masuk
bulan pertama yang masih terbuka. Saat menutup bulan, aplikasi **memperingatkan** jika masih ada
biaya berupa perkiraan. Saat ada pengembalian dana, biaya Midtrans **tidak** ikut dikembalikan
(tetap menjadi beban).

**Tidak dipilih:** mencatat biaya Midtrans baru saat dana dicairkan.

### 9. Pengembalian dana (refund) yang dicatat manual — DIPUTUSKAN

**Aturan:** refund yang dicatat staf dianggap **ditransfer dari Bank utama**. Jika ternyata
dikembalikan lewat dashboard Midtrans, Ibu membuat jurnal koreksi.

**Tidak dipilih:** menganggap semua refund lewat Midtrans.

### 10. Saldo Biteship — DIPUTUSKAN

**Aturan:**
- Top-up dicatat sebagai aset **Saldo Biteship** dengan jurnal manual dari mutasi bank
  (Dr *Saldo Biteship* / Cr *Bank utama*).
- Setiap pemesanan kurir mengurangi Saldo Biteship: bagian yang dibayar pembeli menutup *Titipan
  ongkir pembeli*, subsidi website menjadi beban *Subsidi ongkir website*, dan selisih antara tarif
  sebenarnya dan tarif saat checkout menjadi *Beban ongkos kirim*.
- Pemesanan kurir yang dibatalkan mengembalikan saldo.
- Langganan bulanan (paket Grow) dicatat sebagai *Beban langganan aplikasi*.
- Saldo awal diambil dari dashboard Biteship pada tanggal mulai pembukuan. Setiap akhir bulan saldo
  di pembukuan dicocokkan dengan dashboard; selisihnya dibetulkan dengan jurnal manual.

**Tidak dipilih:** top-up langsung sebagai beban ongkir.

### 11. Saldo Penjual Shopee/TikTok dan pencairannya — DIPUTUSKAN

**Aturan:** hasil penjualan marketplace (setelah biaya) dicatat di akun **Saldo Penjual Shopee**
atau **Saldo Penjual TikTok**. Penarikan ke bank dicatat dengan **jurnal manual** untuk sementara
(nanti otomatis setelah fitur impor laporan penghasilan ada). Biaya yang dibayar dari saldo
marketplace tanpa keterangan marketplace mana masuk akun penampung **Saldo marketplace belum
dipilah**, yang Ibu pindahkan setiap bulan.

**Tidak dipilih:** menganggap penjualan marketplace langsung masuk bank.

---

## C. Persediaan, produksi, dan pembelian

### 12. Metode penilaian persediaan dan HPP — DIPUTUSKAN

**Aturan:** **rata-rata bergerak**, seperti yang sudah dipakai aplikasi: per ukuran dan warna
untuk barang jadi, per warna untuk kain, per jenis untuk aksesoris. HPP setiap pesanan dikunci saat
barang keluar dari stok.

**Tidak dipilih:** FIFO.

### 13. Kapan utang ke pemasok diakui — DIPUTUSKAN

**Aturan:** utang diakui **saat barang diterima**, sebesar nilai barang yang diterima (termasuk
barang yang ditolak karena cacat). Pembayaran sebelum barang datang (DP) dicatat sebagai **Uang
muka pembelian** dan otomatis dipakai menutup utang saat barang datang. Jika pembelian ditutup dan
pembayaran lebih besar dari nilai barang, kelebihannya menjadi **Piutang klaim pemasok**.

**Tidak dipilih:** utang diakui saat pembelian dicatat (saat pesan).

### 14. Ongkir pembelian bahan yang dicatat terpisah — DIPUTUSKAN

**Aturan:** biaya "Ongkir bahan" yang dicatat terpisah tetap menjadi **beban**. Ongkir yang sudah
termasuk dalam total pembelian tetap menjadi bagian harga bahan. **Pembelian kain dan aksesoris
selalu masuk persediaan, tidak pernah menjadi beban**; pembayaran ke pemasok hanya melunasi utang
atau menjadi uang muka.

**Tidak dipilih:** menambahkan ongkir bahan ke harga pokok persediaan.

### 15. Sisa biaya produksi — DIPUTUSKAN

**Aturan (sepenuhnya otomatis, tanpa langkah manual):** selama dijahit, biaya produksi dicatat
sebagai *Barang dalam proses*.
- **Batch yang ditutup lebih awal** (tidak semua potong jadi): seluruh sisa *Barang dalam proses*
  batch itu otomatis dicatat ke **Kerusakan & kehilangan persediaan** (beban usaha, Keputusan 16).
- **Batch yang selesai normal:** sisa kecil akibat pembulatan harga pokok per potong otomatis
  dicatat ke **HPP (Selisih biaya produksi)**.

Contoh nyata: Haura beige L, dipesan 12 potong, hanya 6 jadi karena salah potong. Biaya 6 potong
yang tidak jadi masuk *Kerusakan & kehilangan persediaan* saat batch ditutup.

**Tidak dipilih:** semua sisa masuk HPP, dengan pemindahan manual oleh Ibu untuk batch yang rusak.

### 16. Selisih stok opname, barang rusak, dan barang hilang — DIPUTUSKAN

**Aturan:** selisih hitung stok dicatat ke **Selisih persediaan**; barang rusak atau hilang ke
**Kerusakan & kehilangan persediaan**. Keduanya **beban usaha, bukan HPP**, sebesar nilai
rata-rata saat itu. Laba kotor hanya berisi HPP barang yang terjual (dan selisih pembulatan
produksi).

**Tidak dipilih:** mencatat keduanya sebagai bagian dari HPP.

---

## D. Kas, bank, aset tetap

### 17. Rekening kas dan bank — DIPUTUSKAN

**Aturan:** Ammari memakai **satu rekening bank**. Pembayaran "Tunai" masuk **Kas tunai**,
"Transfer" masuk **Bank utama**. Daftar rekening yang bisa dipilih (juga untuk pesanan manual,
Keputusan 3) untuk sementara hanya Kas tunai dan Bank utama. Jika kelak ada rekening kedua, Ibu
menambahkannya sebagai sub-akun.

**Tidak dipilih:** staf memilih rekening setiap kali mencatat biaya atau pembayaran pemasok.

### 18. Pembayaran dengan "Kartu" — DIPUTUSKAN

**Aturan:** "Kartu" berarti **kartu debit** dan langsung mengurangi **Bank utama**.

**Tidak dipilih:** kartu kredit (Utang kartu kredit). Catatan: jika kelak Ammari memakai kartu
kredit, aplikasi akan menambah pilihan "Kartu kredit" dengan akun *Utang kartu kredit*.

### 19. Penyusutan aset tetap — DIPUTUSKAN

**Aturan:** **garis lurus, mulai bulan perolehan**, umur mengikuti kelompok pajak (Kelompok 1 =
4 tahun, Kelompok 2 = 8 tahun), **nilai sisa 0**, batas kapitalisasi **Rp1.000.000** (pembelian di
bawahnya langsung menjadi beban).

**Tidak dipilih:** umur ekonomis per aset, atau mulai menyusut bulan berikutnya.

---

## E. Pajak

### 20. PPh final 0,5% — DIPUTUSKAN

**Aturan:** PPh final dicatat **setiap bulan**: Dr *Beban PPh final* / Cr *Utang PPh final*.
Pembayaran pajak mengurangi *Utang PPh final* (bukan beban kedua kali).

- **Wajib pajak:** istri pemilik sebagai orang pribadi (NPWP terdaftar tahun 2020).
- **Bebas pajak:** omzet Rp500 juta pertama setiap tahun pajak.
- **Dasar pengenaan:** penjualan setelah voucher, **tanpa ongkir**; penjualan marketplace
  **bruto sebelum biaya marketplace**; dikurangi retur.
- **Tarif, batas bebas pajak, dan tanggal akhir berlakunya tarif** disimpan sebagai
  **pengaturan** yang bisa Ibu ubah, bukan angka tetap. Menurut PP 55/2022 semula, tarif ini
  berakhir pada tahun pajak 2026 untuk NPWP 2020. Pemerintah sudah mengumumkan perpanjangan (sampai
  2029, atau mungkin tanpa batas) melalui revisi PP 55; **Ibu akan memastikan** ketentuannya dan
  mengisi tanggal akhir yang baru. Setelah tanggal akhir, aplikasi berhenti mengusulkan PPh final
  bulanan dan menampilkan peringatan.

**Tidak dipilih:** mencatat PPh final sebagai beban hanya saat disetor.

### 21. PPN — DIPUTUSKAN

**Aturan:** Ammari **belum PKP**; tidak ada akun PPN. PPN yang ikut dibayar (misalnya atas biaya
Midtrans atau marketplace) menjadi bagian biaya. Omzet setahun dipantau; akun PPN ditambahkan bila
Ammari menjadi PKP.

**Tidak dipilih:** menyiapkan akun PPN Masukan/Keluaran sekarang.

---

## F. Mulai pembukuan, tutup buku, dan bentuk usaha

### 22. Tanggal mulai pembukuan dan saldo awal — DIPUTUSKAN

**Aturan:** pembukuan resmi mulai **1 Januari 2027**, dengan **saldo awal per 31 Desember 2026**.
**Desember 2026 adalah bulan uji coba**: jurnal berjalan, tetapi bulan itu tidak dikunci.

Saldo awal: persediaan (kain, aksesoris, barang jadi, barang cacat, barang dalam proses, barang
terjual belum dikirim), utang pemasok, uang muka pembelian, dan uang muka pelanggan **diusulkan
aplikasi** dari datanya, lalu Ibu periksa. Kas dan bank diisi dari rekening koran. Saldo Penjual
Shopee/TikTok, Piutang Midtrans, dan Saldo Biteship diisi dari dashboard masing-masing. Aset tetap
diisi manual. Selisihnya masuk *Modal pemilik*.

**Tidak dipilih:** mulai 1 Desember 2026 bersamaan dengan peluncuran website.

### 23. Penutupan bulan dan koreksi terlambat — DIPUTUSKAN

**Aturan:** bulan ditutup **paling lambat tanggal 10 bulan berikutnya** (setelah impor
marketplace, laporan Midtrans, dan pencocokan bank selesai). Koreksi yang datang setelah bulan
ditutup dicatat di **bulan pertama yang masih terbuka**. Membuka kembali bulan yang sudah ditutup
hanya boleh oleh **pemilik atau akuntan, dengan alasan tertulis**.

**Tidak dipilih:** bulan tidak pernah ditutup.

### 24. Persiapan menjadi PT — DIPUTUSKAN

**Aturan:** saat PT berdiri, pembukuan usaha perorangan **ditutup per tanggal pengalihan**, lalu
PT **dibuka dengan saldo awal sendiri** (aset dan kewajiban yang dialihkan, *Modal disetor*).
Standar akuntansi PT (tetap SAK EMKM atau beralih ke SAK EP) ditentukan saat PT didirikan.

**Tidak dipilih:** melanjutkan pembukuan yang sama dan hanya mengganti nama akun modal.

### 25. Pemetaan kategori biaya ke akun — DIPUTUSKAN

**Aturan:** setiap kategori biaya (dan bila perlu setiap item, misalnya "Biteship Grow" ke *Beban
langganan aplikasi*) dipetakan ke **satu akun**. Kategori baru harus dipetakan dulu sebelum
biayanya bisa dibukukan; sampai itu dilakukan, aplikasi menampilkan peringatan. Kategori untuk
membayar kewajiban (misalnya "Setor pajak") dipetakan ke **akun utangnya**, bukan ke beban.

**Tidak dipilih:** semua kategori baru otomatis masuk *Beban lain-lain*.

---

## Ringkasan

Semua keputusan diputuskan oleh pemilik dan akuntan pada 26 November 2026. Nomornya sama dengan
nomor di rencana teknis (ditulis "D-1", "D-2", dan seterusnya).

| No. | Topik | Aturan |
|---|---|---|
| 1 | Kapan penjualan diakui | Saat barang diserahkan ke kurir (penjualan dan HPP) |
| 2 | Tanggal pesanan marketplace hasil impor | Tanggal kirim/selesai asli dari file ekspor (fitur kecil) |
| 3 | Uang pesanan manual | Staf memilih cara bayar dan rekening per pesanan (fitur kecil); tanpa kredit |
| 4 | Voucher | Potongan penjualan |
| 5 | Biaya marketplace | Beban penjualan pada tanggal penjualan; selisih unggah ulang ke bulan terbuka pertama |
| 6 | Ongkir pembeli dan subsidi ongkir | Titipan ongkir pembeli; subsidi = beban penjualan |
| 7 | Retur, barang cacat, pemakaian pribadi | Retur penjualan; barang cacat dilepas = beban usaha (bukan HPP); hasil lelang = pendapatan lain-lain; prive |
| 8 | Biaya Midtrans | Perkiraan saat bayar, diganti biaya sebenarnya; tidak dikembalikan saat refund |
| 9 | Jalur refund manual | Bank utama; dikoreksi Ibu bila lewat Midtrans |
| 10 | Saldo Biteship | Top-up = aset; dipotong per pengiriman; langganan = beban |
| 11 | Saldo Penjual marketplace | Akun Saldo Penjual; penarikan dijurnal manual; penampung untuk biaya tanpa keterangan |
| 12 | Metode persediaan dan HPP | Rata-rata bergerak |
| 13 | Kapan utang pemasok diakui | Saat barang diterima; DP = uang muka pembelian; lebih bayar = piutang klaim |
| 14 | Ongkir bahan yang dicatat terpisah | Beban; pembelian bahan selalu persediaan |
| 15 | Sisa biaya produksi | Otomatis: batch ditutup awal → kerusakan & kehilangan; pembulatan → HPP |
| 16 | Selisih opname, barang rusak, hilang | Beban usaha, bukan HPP |
| 17 | Rekening kas dan bank | Satu bank: Tunai → Kas tunai, Transfer → Bank utama |
| 18 | Pembayaran kartu | Kartu debit → Bank utama |
| 19 | Penyusutan aset tetap | Garis lurus dari bulan perolehan, kelompok pajak, nilai sisa 0, batas Rp1.000.000 |
| 20 | PPh final 0,5% | Dicatat bulanan; tarif, batas bebas pajak, dan tanggal akhir sebagai pengaturan |
| 21 | PPN | Belum PKP; PPN menjadi bagian biaya |
| 22 | Mulai pembukuan dan saldo awal | 1 Januari 2027; Desember 2026 uji coba |
| 23 | Penutupan bulan | Paling lambat tanggal 10; koreksi ke bulan terbuka pertama; buka ulang dengan alasan tertulis |
| 24 | Menjadi PT | Tutup buku, buka PT dengan saldo awal sendiri |
| 25 | Pemetaan kategori biaya | Satu akun per kategori; kategori baru wajib dipetakan |
