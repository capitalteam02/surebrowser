# SureBrowser

Her sekmesi ayrı proxy ve ayrı oturumla (çerez, giriş, önbellek) çalışan çoklu kimlik tarayıcısı. Windows ve macOS.

## Çalıştırma (geliştirme)

    npm install
    npm start

## Kurulum dosyası ve otomatik güncelleme

Windows kurulum dosyası (`SureBrowser-Setup-x.y.z.exe`) ve Mac paketleri GitHub'da derlenip
**GitHub Releases**'a yüklenir. Kurulu uygulamalar açılışta (ve 4 saatte bir) yeni sürümü denetler,
varsa "Yeni güncelleme var" penceresi çıkar:

- **Windows:** "Güncelle" → indirilir → "Yeniden başlat ve kur". Sekmeler, şifreler, IP'ler korunur.
- **Mac:** Apple imzası (yıllık ücretli Apple Developer hesabı) olmadan Mac uygulamaları kendini güncelleyemez;
  pencere indirme sayfasını açar, yeni `.dmg` elle kurulur. Veriler korunur.

### Bir kerelik kurulum
1. GitHub'da **herkese açık** (public) bir depo oluşturun, adı `surebrowser` olsun.
   (Gizli depoda güncellemeler için uygulamanın içine bir erişim anahtarı gömmek gerekir; bu güvenli değil.)
2. Bu klasörü o depoya gönderin (`git push`).
3. `package.json` içindeki `BURAYA-GITHUB-KULLANICI-ADI` yazan iki yeri GitHub kullanıcı adınızla değiştirin
   (yayınlanan sürümler bunu GitHub'dan zaten otomatik alır; bu yalnızca yerel derlemeler için).

### Her yeni sürüm
    npm run release        # 1.1.0 → 1.2.0, etiketi gönderir
    npm run release:patch  # 1.1.0 → 1.1.1

Etiket gönderilince GitHub Actions ~10 dakikada Windows kurulumunu ve Mac paketlerini derleyip
"Releases" sayfasına koyar. Kurulu uygulamalar bir sonraki açılışta güncellemeyi görür.

Not: Kurulum dosyası imzasız olduğu için Windows ilk kurulumda "Windows kişisel bilgisayarınızı korudu"
uyarısı gösterebilir: "Ek bilgi → Yine de çalıştır". Bu uyarıyı kaldırmak için kod imzalama sertifikası gerekir.

## Kullanım

- **Kimlik = ülke + renk.** Her ülkenin 10 rengi var (ör. Türkiye · Kırmızı, Almanya · Kırmızı). IP'lerin ülkesi denetlenirken otomatik bulunur.
- **Ctrl/⌘+T**: "Hangi ülkeden, hangi renkten IP?" ekranı. Ülkeler liste halinde, Türkiye en üstte. Sekmede o ülkenin bayrağı görünür.
- **Her kimliğin kendi hafızası var.** Çerezler, girişler, önbellek ve site verileri kimliğe aittir ve diskte saklanır. Sekmeyi kapatıp aynı kimliği sonra açarsanız oturumunuz durur.
- **IP çökerse aynı ülkeden yenisi gelir, oturum korunur.** Aktif IP'ler dakikada bir, tüm havuz 20 dakikada bir denetlenir.
- **Bir kimlik istediğiniz kadar sekmede açılabilir** (aynı IP, aynı oturum). Farklı kimlikler aynı IP'yi paylaşmaz.
- **Gruplar ve yan yana görünüm (en fazla 6 sekme):** ızgara düğmesine (Ctrl/⌘+Shift+G) basın ya da Ctrl/⌘ ile sekmelere tıklayın, sekmeleri seçip "Grupla ve yan yana göster" deyin. Grup sekmeleri pencereye sığacak şekilde dizilir ve küçültülür. Grupta yer varsa "Bu gruba sekme ekle" kutusundan doğrudan yeni sekme açılır. Sekme çubuğundaki grup etiketine tıklayınca grup yan yana açılır; çift tık: yeniden adlandır, sağ tık: grubu çöz / sekmeleri kapat. Sekmeye sağ tık → "Gruba ekle / Gruptan çıkar".
- **Sekmeyi pencereden dışarı sürükleyin:** ayrı bir pencerede açılır (Chrome gibi). Başka pencerenin sekme çubuğuna bırakırsanız oraya geçer. Ctrl/⌘+N yeni pencere.
- **İzin sorusu yok:** bildirim, konum, kamera/mikrofon, pano gibi izinler sormadan verilir; indirmeler doğrudan İndirilenler klasörüne gider.
- **Şifreler (Chrome gibi):** Bir sitede giriş yapınca alt çubukta "şifre kaydedilsin mi?" diye sorulur. Kayıtlı şifre, o kimlikte siteye girince otomatik doldurulur. Şifreler kimliğe özeldir: Türkiye · Kırmızı'nın şifresi Almanya · Kırmızı'da doldurulmaz. Liste, gösterme, kopyalama ve silme: panelde "Şifreler".
- **Açılışta son haline döner:** tüm pencereler (konum ve boyutlarıyla), sekmeleri, sıraları, her sekmenin geri/ileri geçmişi, ızgara görünümü ve en son açık olan sekme.
- Havuzda her IP'ye renk ve not verilebilir; etkin sekmenin notu sol altta etiket olarak görünür.

Desteklenen satır biçimleri:

    socks5://kullanici:sifre@1.2.3.4:1080
    http://1.2.3.4:8080
    1.2.3.4:8080:kullanici:sifre
    kullanici:sifre@1.2.3.4:8080
    Instagram hesabı | socks5://1.2.3.4:1080

## Gizlilik korumaları

- WebRTC yalnızca proxy üzerinden (gerçek IP sızmaz).
- Bir rengin IP'si kalmazsa sekme **engellenir**, gerçek IP'ye düşmez.
- SOCKS5 ile DNS çözümlemesi proxy tarafında yapılır.
- Kullanıcı agent'ı standart Chrome'dur ("Electron" ibaresi yok).
- Proxy ve site şifreleri işletim sisteminin anahtar zinciriyle (macOS Anahtar Zinciri, Windows DPAPI) şifrelenip saklanır.

Sınırlar: saat dilimi, ekran, font ve canvas parmak izleri sekmeler arasında aynıdır. 
