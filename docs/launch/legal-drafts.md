# Drafts: Kebijakan Privasi and Syarat & Ketentuan (checkout launch)

> **For the owner, before pasting.** Read and adjust first; you know the live text, which this draft
> replaces in full. Built from `docs/plans/cart-checkout.md` §11, §11.1, §16 and the code as of
> session 17.
>
> - **How to paste.** Open this file rendered (GitHub's file view, or VS Code's Markdown preview),
>   select one page's text from its first `##` heading to the end of that page, copy, and paste
>   into admin **Konten → Halaman → Kebijakan Privasi** (or **Syarat & Ketentuan**). The editor keeps
>   the `##` headings as section headings and the lists as lists. The `#` page titles are not part
>   of the text: the page shows its own title. **Simpan draf**, check the preview, **Terbitkan**.
> - **Names.** The drafts name neither the payment processor nor the shipping provider (storefront
>   rule). If Midtrans' merchant review asks for the processor to be named, add the optional
>   sentence marked in section 5 of the privacy policy (plan §11.1 allows this one exception).
> - **Fill in before publishing:** the two `[...]` contact placeholders (support email and
>   WhatsApp number as shown in Konten → Pengaturan) and the dates.
> - **Check with the code owner before publishing** (one claim the code does not do yet): section 7
>   promises that contact and address data of **unpaid, expired orders is anonymized after 90
>   days**. That job is not built (plan §11, session 12 decision 29). The first checkout orders can
>   only reach 90 days on 1 Mar 2027, so building it before then keeps the policy true; otherwise
>   change that sentence.
> - No em dash anywhere, no city named, no "gratis ongkir".

---

# Kebijakan Privasi

## Tentang kebijakan ini

Kebijakan ini menjelaskan data pribadi apa yang dikumpulkan Ammari saat kamu memakai situs ammari.id, untuk apa data itu dipakai, kepada siapa data itu dibagikan, berapa lama disimpan, dan apa saja hak kamu sesuai Undang-Undang Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi (UU PDP).

Ammari adalah pengendali data pribadi yang kamu berikan di situs ini. Pertanyaan atau permintaan tentang data pribadimu bisa dikirim ke [email dukungan] atau WhatsApp [nomor WhatsApp].

Berlaku sejak: [1 Desember 2026]. Terakhir diperbarui: [tanggal].

## Data yang kami kumpulkan

**Saat kamu membuat akun atau masuk:**

- Alamat email.
- Nama dan alamat email dari akun Google, jika kamu masuk dengan Google.
- Nama dan nomor HP, jika kamu melengkapinya di halaman akun.
- Persetujuan pemrosesan data dan persetujuan menerima promo (beserta waktunya).

**Saat kamu mengklaim voucher dari kartu terima kasih:** data kartu yang diklaim dan voucher yang diterbitkan untuk akunmu.

**Saat kamu berbelanja (checkout):**

- Email dan nomor WhatsApp untuk menghubungimu tentang pesanan.
- Nama dan nomor HP penerima, alamat pengiriman lengkap, kecamatan, kode pos, dan catatan untuk kurir.
- Isi pesanan, harga, ongkos kirim, voucher yang dipakai, dan berat paket.
- Status pembayaran dan jenis metode pembayaran yang kamu pilih (misalnya QRIS atau virtual account).
- Pilihan persetujuan syarat dan ketentuan serta persetujuan promo pada pesanan itu.

Kami **tidak** menerima atau menyimpan nomor kartu, PIN, kata sandi bank, atau data login dompet digitalmu. Pembayaran dilakukan di halaman penyedia jasa pembayaran. Ammari tidak menerima pembayaran dengan kartu kredit.

**Data teknis:** alamat IP dan waktu akses, dipakai untuk keamanan dan untuk membatasi percobaan yang berlebihan (misalnya terlalu banyak permintaan kode masuk), serta cookie yang dijelaskan di bagian Cookie.

## Untuk apa data dipakai

- Memproses, mengirim, dan melacak pesananmu.
- Mengonfirmasi pembayaran dan memproses pengembalian dana.
- Mengirim email tentang pesanan: pesanan dibuat, pembayaran diterima, pesanan dikirim, dan pesanan dibatalkan.
- Membuat dan mengamankan akunmu serta mengirim kode atau link masuk.
- Mengelola voucher dari program kartu terima kasih.
- Menjawab pertanyaan dan keluhan lewat layanan pelanggan.
- Memenuhi kewajiban hukum, termasuk pembukuan dan perpajakan.
- Mengirim promo, **hanya** jika kamu memberi persetujuan promo secara terpisah. Persetujuan ini bisa kamu tarik kapan saja.

Dasar pemrosesannya adalah persetujuanmu, pelaksanaan perjanjian jual beli saat kamu memesan, dan kewajiban hukum Ammari.

## Akun dan cara masuk

- Masuk ke akun tidak memakai kata sandi. Kamu bisa masuk dengan kode yang dikirim ke email, dengan akun Google, atau dengan link masuk sekali pakai yang dikirim lewat email pesanan. Link masuk berlaku 24 jam, hanya bisa dipakai sekali, dan baru membuatmu masuk setelah kamu menekan tombol "Masuk" di halaman konfirmasi. Ammari tidak menyimpan kata sandi apa pun.
- Checkout tanpa akun tetap membuat atau menautkan akun berdasarkan alamat email yang kamu isi, tetapi tidak membuatmu otomatis masuk. Nomor WhatsApp dan pilihan promo dari pesanan tidak disalin ke akunmu tanpa persetujuanmu setelah kamu masuk.
- Email pesanan juga berisi link "Lihat pesanan" yang hanya membuka pesanan itu saja, berlaku 120 hari.

## Kepada siapa data dibagikan

Ammari **tidak menjual** data pribadimu. Data hanya dibagikan sebatas yang diperlukan kepada:

- **Penyedia jasa pembayaran berizin**, untuk memproses pembayaranmu: nomor pesanan, jumlah yang dibayar, rincian barang, nama, email, dan nomor telepon. [Opsional, hanya jika diminta saat peninjauan pedagang: "Penyedia jasa pembayaran kami adalah Midtrans (PT Midtrans)."]
- **Penyedia layanan pengiriman dan perusahaan kurir:**
  - saat kamu mencari kecamatan, teks yang kamu ketik (nama kecamatan, kota, atau kode pos) dikirim untuk menemukan wilayahnya;
  - saat ongkos kirim dihitung, hanya wilayah tujuan (kecamatan dan kode pos), berat paket, dan total nilai barang yang dikirim, tanpa nama, nomor telepon, atau alamat jalan;
  - setelah pesanan dibayar dan dikirim, nama dan nomor HP penerima, alamat lengkap, dan isi paket diberikan kepada penyedia layanan pengiriman dan kurir untuk mengantar paket dan menyediakan pelacakan.
- **Penyedia layanan email**, untuk mengirim kode masuk dan email pesanan.
- **Penyedia infrastruktur** (server, jaringan dan keamanan situs, serta penyimpanan gambar), yang memproses data atas nama Ammari untuk menjalankan situs ini.
- **Instansi yang berwenang**, jika diwajibkan oleh hukum.

## Berapa lama data disimpan

- Pesanan yang sudah dibayar, rincian barang, data pembayaran, dan alamat pengiriman: 10 tahun untuk kewajiban pembukuan. Setelah itu data kontak pada pesanan disamarkan.
- Pesanan yang tidak dibayar dan kedaluwarsa atau dibatalkan: data kontak dan alamatnya disamarkan setelah 90 hari. Catatan pesanannya tetap disimpan tanpa data pribadi untuk keperluan statistik.
- Keranjang belanja: 30 hari tanpa aktivitas untuk pengunjung tanpa akun, 180 hari tanpa aktivitas untuk pemilik akun.
- Catatan notifikasi pembayaran: 12 bulan.
- Link "Lihat pesanan": berlaku 120 hari, catatannya dihapus 30 hari setelah habis masa berlakunya. Link masuk sekali pakai: berlaku 24 jam, catatannya dihapus 30 hari setelah dipakai atau habis masa berlakunya.
- Data akun: selama akunmu ada. Jika kamu meminta akun dihapus, data akun dihapus, kecuali catatan pesanan yang wajib disimpan untuk pembukuan.

## Keamanan

Situs ini hanya bisa diakses lewat koneksi terenkripsi (HTTPS). Kode masuk, link masuk, link lihat pesanan, dan token kartu terima kasih disimpan hanya dalam bentuk sandi satu arah (hash), bukan teks aslinya. Akses ke data pesanan di sisi Ammari dibatasi untuk staf yang membutuhkannya.

## Hak kamu

Sesuai UU PDP, kamu berhak:

- mengetahui dan meminta salinan data pribadimu yang kami simpan;
- memperbaiki data yang tidak akurat;
- meminta penghapusan akun dan data pribadimu, dengan pengecualian catatan pesanan yang wajib kami simpan;
- menarik persetujuan promo kapan saja;
- menarik persetujuan pemrosesan data, dengan konsekuensi akun tidak bisa dipakai lagi;
- mengajukan keberatan atas pemrosesan datamu.

Kirim permintaan ke [email dukungan] atau WhatsApp [nomor WhatsApp]. Kami akan memeriksa bahwa permintaan memang berasal dari pemilik data sebelum menindaklanjutinya.

## Cookie

Situs ini hanya memakai cookie yang diperlukan agar situs berfungsi, dan tidak memakai cookie iklan:

- cookie sesi masuk, agar kamu tetap masuk (hingga 60 hari);
- cookie keranjang, untuk menyimpan keranjang pengunjung tanpa akun (hingga 60 hari);
- cookie checkout, agar kamu bisa membuka kembali status pesanan yang baru kamu buat (7 hari);
- cookie lihat pesanan, dari link "Lihat pesanan" di email, hanya untuk pesanan itu (selama link berlaku).

## Perubahan kebijakan

Jika kebijakan ini berubah, versi terbaru dimuat di halaman ini dengan tanggal pembaruan yang baru. Untuk perubahan penting, kami juga akan memberi tahu lewat situs atau email.

---

# Syarat & Ketentuan

## Umum

Syarat dan ketentuan ini berlaku untuk penggunaan situs ammari.id dan setiap pembelian di situs ini. Dengan membuat pesanan, kamu menyetujui syarat dan ketentuan ini serta Kebijakan Privasi Ammari.

Berlaku sejak: [1 Desember 2026]. Terakhir diperbarui: [tanggal].

## Akun

- Kamu bisa berbelanja tanpa akun. Pesanan tetap ditautkan ke akun berdasarkan alamat email yang kamu isi.
- Masuk ke akun tidak memakai kata sandi: lewat kode email, akun Google, atau link masuk sekali pakai dari email pesanan.
- Jaga akses ke email dan nomor WhatsApp yang kamu pakai, karena informasi pesanan dikirim ke sana.

## Pemesanan

- Pesanan dibuat saat kamu menekan **"Bayar sekarang"** di halaman checkout, dan baru terkonfirmasi setelah pembayarannya kami terima.
- Satu pesanan berisi paling banyak 10 buah per produk dan 20 buah secara keseluruhan.
- Pastikan data penerima dan alamat sudah benar sebelum membayar. Alamat pesanan yang sudah dibuat tidak bisa diubah lewat situs; hubungi layanan pelanggan jika ada kesalahan.

## Harga dan ongkos kirim

- Semua harga dalam Rupiah dan sama untuk setiap lokasi pengiriman.
- Ammari menanggung ongkos kirim hingga **Rp20.000 per pesanan** (subsidi ongkir). Jika ongkos kirim ke alamatmu lebih dari Rp20.000, kamu membayar selisihnya. Jumlah ini ditampilkan sebagai "Ongkir" sebelum kamu membayar dan sudah termasuk dalam total.
- Tidak ada biaya tambahan lain di checkout.
- Voucher tidak berlaku untuk ongkos kirim.

## Pembayaran

- Pembayaran dilakukan dalam **60 menit** setelah pesanan dibuat, dengan QRIS, dompet digital (GoPay, ShopeePay), atau virtual account (BCA, BNI, BRI, Mandiri, Permata). Pembayaran dengan kartu kredit tidak tersedia.
- Pesanan yang tidak dibayar dalam waktu tersebut dibatalkan otomatis, dan stoknya dilepas kembali.
- Status pembayaran hanya kami anggap berhasil setelah kami menerima konfirmasi langsung dari penyedia jasa pembayaran.

## Voucher

- Nilai voucher Rp20.000. Satu voucher untuk satu pesanan, tanpa minimum belanja.
- Voucher hanya bisa dipakai di checkout ammari.id saat kamu masuk ke akun, tidak bisa ditukar dengan uang, dan potongannya tidak bisa melebihi total harga barang.
- Voucher berlaku sesuai masa berlaku yang tertera di akunmu.
- Jika pesanan dibatalkan atau pembayarannya kedaluwarsa, voucher dikembalikan ke akunmu selama masa berlakunya belum habis. Voucher tidak dikembalikan untuk pesanan yang diretur setelah diterima.

## Ketersediaan stok

Stok diperiksa saat pesanan dibuat dan disimpan untukmu selama waktu pembayaran. Jika setelah pembayaran ternyata barang tidak tersedia, Ammari akan menghubungimu dan mengembalikan dana secara penuh.

## Pengiriman

- Ammari memilih kurir dan layanan reguler dengan ongkos termurah yang tersedia untuk alamatmu. Layanan yang dipakai ditampilkan di checkout.
- Lama pengiriman bergantung pada kurir dan tidak dijamin.
- Beberapa wilayah mungkin belum bisa dilayani lewat situs. Untuk wilayah tersebut, silakan memesan lewat WhatsApp.
- Nomor resi dikirim lewat email setelah pesanan dikirim, dan status pengiriman bisa dilihat di "Pesanan saya".
- Pesanan dinyatakan selesai setelah paket dinyatakan sampai di alamat tujuan.

## Pembatalan dan pengembalian dana

- Pesanan yang belum dibayar tidak perlu dibatalkan: pesanan itu batal otomatis setelah 60 menit.
- Untuk membatalkan pesanan yang sudah dibayar, hubungi layanan pelanggan. Pesanan yang dibatalkan sebelum dikirim, baik atas permintaanmu maupun oleh Ammari, dananya dikembalikan **penuh, termasuk ongkos kirim**. Tim kami akan menghubungimu lewat WhatsApp untuk proses pengembaliannya.
- Pengembalian dan penukaran barang setelah diterima, termasuk apakah ongkos kirim ikut dikembalikan, mengikuti halaman **Pengembalian & Penukaran**.

## Layanan pelanggan

Pertanyaan tentang pesanan bisa dikirim ke [email dukungan] atau WhatsApp [nomor WhatsApp]. Sertakan nomor pesanan (ORD-...) agar kami bisa membantu lebih cepat.

## Perubahan syarat dan ketentuan

Ammari dapat memperbarui syarat dan ketentuan ini. Versi yang berlaku adalah versi yang dimuat di halaman ini saat pesanan dibuat.
