# V-MES — IIoT veri toplama ve OEE sistemi

Siemens S7 PLC'lerden veri toplayan, makineleri canlı izleyen ve OEE (Kullanılabilirlik × Performans × Kalite) raporlayan üretim yürütme sistemi.

```
PLC (S7-1200/1500) → Node-RED (edge) → EMQX (MQTT) → Ingestion → MS SQL Server
                                                         │              │
                                       Web (React) ←── Socket.io     FastAPI (OEE, konfigürasyon)
```

Mimari kararlar, veri modeli ve OEE hesaplama kuralları: **[ARCHITECTURE.md](ARCHITECTURE.md)**.
Ubuntu Server sanal makineye adım adım kurulum: **[docs/KURULUM-UBUNTU.md](docs/KURULUM-UBUNTU.md)** (Windows + WSL2 için: [docs/KURULUM-WSL.md](docs/KURULUM-WSL.md)).
Yeni makine (ve HUBBOX) ekleme iş akışı: **[docs/YENI-MAKINE-EKLEME.md](docs/YENI-MAKINE-EKLEME.md)**.

---

## İçindekiler

1. [Gereksinimler](#gereksinimler)
2. [Hızlı başlangıç (geliştirme)](#hızlı-başlangıç-geliştirme)
3. [Servisler ve adresler](#servisler-ve-adresler)
4. [Günlük komutlar](#günlük-komutlar)
5. [İlk kurulum: makine ekleme](#ilk-kurulum-makine-ekleme)
6. [Üretim kurulumu](#üretim-kurulumu)
7. [İşletim](#işletim)
8. [Sorun giderme](#sorun-giderme)
9. [Testler](#testler)
10. [Proje yapısı](#proje-yapısı)

---

## Gereksinimler

- Docker Engine / Docker Desktop (Compose v2.24+; `!override` etiketi için)
- En az 4 GB RAM (MS SQL Server tek başına ~2 GB kullanır)
- `make` (macOS/Linux'ta hazır gelir)

Yerelde Node.js veya Python kurulu olması **gerekmez**: tüm derleme ve testler Docker içinde çalışır. (Editör desteği için Node 24 ve Python 3.12 kurmak faydalıdır.)

## Hızlı başlangıç (geliştirme)

```bash
cp .env.example .env          # şifreleri değiştirin; JWT_SECRET için: openssl rand -hex 32
make up                       # altyapı + migration + tüm servisler
make seed                     # örnek veri: 2 alan, 3 makine, ürünler, vardiyalar, duruş nedenleri
make flows-deploy             # Node-RED akışlarını üret ve dağıt (simülatörden veri akmaya başlar)
```

Ardından **http://localhost:8080** adresinden `.env` içindeki `ADMIN_USERNAME` / `ADMIN_PASSWORD` ile giriş yapın.

`.env.example` içindeki `COMPOSE_PROFILES=dev` satırı **simülatörü** de başlatır: dört sanal S7 PLC'si (2 CNC, 1 pres, 1 seri istasyonlu montaj hattı) gerçek S7 protokolüyle veri üretir; rastgele duruşlar, mikro duruşlar, hurda ve hız kayıpları içerir. Montaj hattının 5 istasyonu var ve 3. istasyon en yavaşı; makine detayındaki **İstasyonlar** (darboğaz) kartı bunu göstermelidir.

> **Aynı makinede başka bir Docker projesi varsa** port çakışmalarını önlemek için `.env` içinde `*_PORT` değerlerini değiştirin. Compose proje adı `v-mes-2`'dir; değiştirmeyin.

## Servisler ve adresler

Varsayılan portlar (`.env` ile değiştirilebilir):

| Servis | Adres | Açıklama |
|---|---|---|
| Web | http://localhost:8080 | Arayüz; `/api` ve `/socket.io` aynı adresten yönlendirilir |
| API | http://localhost:8000/api/docs | OpenAPI dokümanı |
| Ingestion | http://localhost:3001/health | MQTT → DB, canlı yayın, sağlık durumu |
| Node-RED | http://localhost:1880 | Edge akışları (`NODERED_ADMIN_*` ile giriş) |
| EMQX paneli | http://localhost:18083 | MQTT broker (`EMQX_DASHBOARD_*` ile giriş) |
| MQTT | localhost:1883 | Kullanıcı/şifre zorunlu, topic ACL'li |
| MS SQL | localhost:1433 | `MES_DB`; uygulama kullanıcısı `MSSQL_APP_USER` |
| Simülatör | http://localhost:8090/machines | Yalnızca `dev` profili; kontrol API'si |

**Simülatör kontrol API'si** (test senaryoları için):

```bash
curl -X POST "localhost:8090/machines/cnc-02/stop?seconds=90"        # 90 sn duruş (≥ 60 sn → duruş kaydı)
curl -X POST "localhost:8090/machines/cnc-02/resume"
curl -X POST "localhost:8090/machines/pres-01/disconnect?seconds=40" # PLC bağlantı kopması
curl -X POST "localhost:8090/machines/pres-01/reset-counters"        # sayaç sıfırlanması
```

## Günlük komutlar

| Komut | Ne yapar |
|---|---|
| `make up` / `make down` | Tüm servisleri başlatır / durdurur (veriler volume'larda kalır) |
| `make logs` | Tüm servislerin logları |
| `make migrate` | Bekleyen veritabanı migration'larını uygular |
| `make seed` | Migration + örnek veri (idempotent) |
| `make flows-preview` / `make flows-deploy` | Node-RED akış farkını gösterir / dağıtır (arayüzde: PLC konfigüratörü → Dağıt) |
| `make test` | Tüm birim testleri (TS + Python) |
| `make test-api-int` | API entegrasyon testleri (ayrı `MES_TEST` veritabanı; geliştirme verisine dokunmaz) |
| `make e2e` | Tarayıcıdan uçtan uca testler (çalışan dev stack'e karşı) |
| `make smoke` | Socket.io canlı yayın duman testi |
| `make backup` | Veritabanı yedeği (`./backups`) |
| `make certs` | Geliştirme için kendinden imzalı TLS sertifikaları |

## İlk kurulum: makine ekleme

Her makinenin PLC'si, o makinedeki **edge gateway** (HUBBOX içindeki Node-RED) tarafından okunur. Tamamı arayüzden yapılır (mühendis veya yönetici rolü).

| Adım | Kim | Ne |
|---|---|---|
| 1 | Otomasyon / saha | HUBBOX'ı hazırlar: Node-RED + `node-red-contrib-s7` (3.x), NTP, ortak Node-RED kullanıcı/şifresi. PLC'de PUT/GET açık, okunacak DB optimize edilmemiş. |
| 2 | IT | Sunucu → HUBBOX `:1880` ve HUBBOX → sunucu `:1883` erişimi |
| 3 | **Edge cihazları** | **Edge ekle**: kod (ör. `hubbox-mekanik`), ad, Node-RED adresi → **Kontrol** ile uyumluluğu doğrula |
| 4 | **PLC konfigüratörü** | Alan → hat → **makine** ekle; **edge**'i seç; PLC adresi (her HUBBOX'ın kendi izole ağı olduğu için hepsinde `192.168.10.1` olabilir), port 102, rack/slot `0/1` (S7-1200/1500) |
| 5 | Tag'ler | **TIA'dan içe aktar** (DB tablosu .xlsx/.csv veya DB editöründen yapıştır) → satırları seç, ad ve rol ata. Aynı tip makinelerde **Başka makineden kopyala**. |
| 6 | Dağıtım | **Node-RED dağıtımı** kartında yalnızca değişen edge'ler listelenir → **Dağıt** |
| 7 | Doğrulama | Canlı panelde makine durumu ve tag değerleri; **Tanımlar → Ürünler**'de bu makinenin ideal çevrim süreleri; **Vardiyalar** |

**Makine ayarları**
- **Makine kodu** (ör. `mekanik-01`) UNS kimliğidir; sonradan değiştirilemez.
- **Çalışma durumu kaynağı:** PLC'de çalışıyor bit'i/durum kodu varsa *PLC durum tag'i*, yoksa *sayaç hareketinden* (eşik süresiyle).
- **Hurda kaynağı:** PLC'de hurda sayacı varsa *PLC*, yoksa *operatör girişi*.
- `total_count` rolü zorunludur; sayaçlar DINT/DWORD/WORD olmalıdır. 16 bit (UInt/WORD) sayaçların 65.535 → 0 taşması kayıpsız hesaplanır.

**İçe aktarma** TIA tablosundaki sütunları içeriğe göre tanır (ad, veri tipi, `892.1` biçiminde ofset); struct/dizi satırlarını ad öneki yapar (`MakinaIstasyonData[2].kosuBiti` → `DB200,X902.2`). Tipi boş bırakılmış bit satırları Bool varsayılır ve işaretlenir. String, LReal, 64 bit, Time/DTL tipleri şimdilik okunmaz.

**PLC tarafı (TIA Portal, S7-1200/1500):**
- Okunacak DB'lerin özelliklerinde **"Optimized block access" kapalı** olmalı (DB editöründe "Offset" sütunu görünür).
- CPU → Protection & Security → **"Permit access with PUT/GET communication" açık** olmalı.
- PLC'ye yazma yapılmaz; sistem salt okunurdur.

**Günlük kullanım:** Operatörler **Operatör ekranı**ndan (tablet) iş emrini başlatır/tamamlar, duruşlara neden girer ve gerekiyorsa hurda girer. İş emri olmadan yapılan üretimde ideal hız bilinmediği için performans ve OEE hesaplanmaz; arayüz bunu açıkça belirtir.

## Üretim kurulumu

Üretim, temel compose dosyasının üzerine `docker-compose.prod.yml` katmanıyla çalışır:

- Web yalnızca **HTTPS** (443; 80 → 443 yönlendirme, HSTS); refresh çerezi `Secure`.
- MS SQL, Node-RED editörü ve EMQX paneli yalnızca sunucunun kendisinden (`127.0.0.1`) erişilebilir; API ve ingestion portları dışarıya kapalıdır (web üzerinden erişilir).
- Saha edge'leri broker'a **MQTT TLS (8883)** ile bağlanır.

### 1. Ortam dosyası

```bash
cp .env.example .env
```

- Tüm `ChangeMe_*` şifrelerini ve `NODERED_CREDENTIAL_SECRET`'ı değiştirin; `JWT_SECRET`: `openssl rand -hex 32`.
- `COMPOSE_PROFILES=dev` satırını **silin** (simülatör çalışmasın).
- `MSSQL_PID`: lisansınıza göre `Standard`, `Enterprise` veya `Express` (`Developer` üretimde kullanılamaz). Express 10 GB veritabanı sınırına dikkat; saklama süresini (`raw_retention_days`) buna göre ayarlayın.
- Edge sahada ve broker merkezde ise `FLOW_MQTT_TLS=true`.
- İlk girişten sonra arayüzden kendi yönetici hesabınızı oluşturup `ADMIN_PASSWORD`'ü `.env`'den kaldırabilirsiniz (yalnızca hiç kullanıcı yokken kullanılır).

### 2. TLS sertifikaları

`infra/certs/` altına şu dosyalar konur:

| Dosya | Kullanım |
|---|---|
| `server.crt`, `server.key` | Web (HTTPS) ve EMQX (8883). SAN, kullanıcıların ve edge'lerin bağlandığı ad/IP'yi içermeli |
| `ca.crt` | Sertifikayı imzalayan CA; Node-RED broker sertifikasını bununla doğrular |

Kurumsal CA'nızdan alınmış sertifikaları kullanın. Test için kendinden imzalı:

```bash
scripts/gen-certs.sh mes.fabrika.local 10.0.0.15   # ad ve sunucu IP'si
```

(Kendinden imzalı CA kullanılıyorsa `ca.crt` tarayıcılara/tabletlere güvenilir kök olarak yüklenmelidir.)

### 3. Başlatma

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose run --rm db-migrate
```

Ardından arayüzden makineleri tanımlayıp Node-RED'e dağıtın.

### Edge: HUBBOX içindeki Node-RED

PLC'ler izole makine ağında olduğu için PLC'yi okuyan Node-RED, ağa erişimi olan **HUBBOX gateway'inin içinde** çalışır. Merkezdeki API, akışları HUBBOX'taki Node-RED'e Admin API ile dağıtır; Node-RED telemetriyi merkezdeki EMQX'e gönderir. HUBBOX'taki mevcut akışlara dokunulmaz (yalnızca `mes-` önekli sekmeler yönetilir).

```
PLC ──S7/102──► HUBBOX (Node-RED) ──MQTT 1883/8883──► Sanal makine (EMQX, ingestion, API, DB, web)
                       ▲
                       └────────── HTTP 1880 (Admin API: akış dağıtımı) ──── API
```

**Ön koşullar**
- HUBBOX Node-RED'de `node-red-contrib-s7` (3.x) yüklü olmalı.
- Sanal makine → HUBBOX `:1880` (akış dağıtımı) ve HUBBOX → sanal makine `:1883` (veya TLS ile `:8883`) erişimi açık olmalı (kurumsal güvenlik duvarı).
- HUBBOX saati **NTP ile senkron** olmalı: zaman damgaları edge'de atanır. Ingestion kaymayı heartbeat'lerden ölçer; 30 sn'yi aşarsa arayüzün sol alt köşesinde uyarı görünür.
- Güvenlik: HUBBOX güvenlik duvarında PLC'nin 102 portunu yalnızca HUBBOX'ın kendisine açık bırakın.

**`.env` ayarları** (tüm edge'ler için ortak)

```ini
EDGE_NODERED_USER=...            # HUBBOX Node-RED kullanıcı adı (adminAuth kapalıysa boş)
EDGE_NODERED_PASSWORD=...
FLOW_MQTT_MODE=inline            # HUBBOX konteynerinin ortam değişkenlerini yönetmiyoruz
FLOW_MQTT_HOST=10.146.x.x        # sunucunun kurumsal IP'si (HUBBOX'lardan erişilebilir olmalı)
FLOW_MQTT_USER=nodered           # = MQTT_NODERED_USER
FLOW_MQTT_PASSWORD=...           # = MQTT_NODERED_PASSWORD
```

Edge adresleri arayüzde **Edge cihazları** sayfasından eklenir. **Kontrol** (veya `docker compose --profile tools run --rm flow-cli check`) her edge için Node-RED erişimini, kimlik doğrulamayı, Node-RED ve `node-red-contrib-s7` sürümlerini, mevcut sekmeleri/S7 bağlantılarını ve akışların hangi MQTT adresine bağlanacağını gösterir (salt okunur). Dağıtım her edge'e ayrı yapılır; erişilemeyen bir edge diğerlerini engellemez.

## İşletim

### Sağlık kontrolleri

```bash
docker compose ps                                  # tüm servisler "healthy" olmalı
curl -s localhost:3001/health | python3 -m json.tool   # ingestion: MQTT, DB, tampon, reddedilen mesajlar
```

Arayüzün sol alt köşesindeki gösterge canlı bağlantıyı ve edge (Node-RED) erişilebilirliğini gösterir.

### Zamanlanmış bakım işleri

API süreci içinde çalışır (`JOBS_ENABLED=false` ile kapatılabilir). Birden fazla API örneği olsa da her iş tek örnekte çalışır.

| İş | Zaman | Ne yapar |
|---|---|---|
| `telemetry_partitions` | saatte bir | Gelecek 3 ayın aylık telemetri partition'larını oluşturur |
| `telemetry_purge` | her gece (bakım saati, varsayılan 02:00) | `raw_retention_days`'ten eski ham telemetriyi siler (dakikalık sayaç özetleri ve OEE verisi korunur) |
| `telemetry_compress` | her gece | Columnstore sıkıştırması |
| `auth_cleanup` | her gece | Süresi dolmuş oturumları siler |

Durum ve elle tetikleme (yönetici): `GET /api/admin/jobs`, `POST /api/admin/jobs/{ad}/run`.

### Yedekleme ve geri yükleme

```bash
make backup                                          # ./backups/MES_DB_<zaman>.bak (doğrulanır; 14 günden eskiler silinir)
scripts/restore.sh backups/MES_DB_20261019_020000.bak --yes   # MEVCUT VERİTABANININ ÜZERİNE YAZAR
```

Linux sunucuda `backups` klasörü MSSQL konteynerinin kullanıcısına ait olmalıdır (`sudo chown 10001:10001 backups`). Yedeklemeyi günlük zamanlayın (root cron: `0 3 * * * cd /opt/v-mes && ./scripts/backup.sh`) ve `./backups` klasörünü sunucu dışına kopyalayın. Geri yükleme sırasında API ve ingestion durdurulur; bu sürede MQTT'de bekleyen QoS 1 mesajlar ingestion açıldığında işlenir.

### Loglar

Tüm servisler JSON-file sürücüsüyle 5 × 10 MB döndürmeli log tutar: `docker compose logs -f ingestion`. Ingestion logları JSON'dur; durum değişiklikleri (`durum değişti`), sayaç olayları (`sayaç olayı`: sıfırlanma/anomali) ve reddedilen mesajlar (`mesaj reddedildi`) aranabilir.

### Güncelleme

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose run --rm db-migrate
```

Migration'lar sıralı ve bir kez uygulanır; uygulanmış bir migration dosyası değiştirilirse araç durur.

## Sorun giderme

| Belirti | Olası neden / çözüm |
|---|---|
| Makine "Bağlantı yok" | Node-RED PLC'ye ulaşamıyor: IP/port/rack/slot, HUBBOX rotası, PUT/GET izni. Node-RED loglarında `ECONNREFUSED`/`timeout` arayın. |
| PLC'ye bağlanıyor ama değer gelmiyor / hatalı | DB'de "Optimized block access" açık olabilir; adres ofsetlerini TIA Portal'daki DB düzeniyle karşılaştırın. |
| OEE ve performans "—" | Üretim iş emri olmadan yapılmış veya ürün için o makinede ideal çevrim süresi tanımlı değil (raporda uyarı görünür). |
| Raporlarda "veri yok" uyarısı | O süre boyunca ingestion/edge çalışmıyordu; süre OEE'ye katılmaz. |
| Beklenmedik üretim/hurda sıçraması yok ama log'da "anomali" | Sayaç geriye veya çok ileri atladı (PLC programı yeniden yüklendi, ön ayar). Sistem bunu üretim saymaz; doğru davranıştır. |
| Node-RED dağıtımı "çakışma" | Node-RED'de biri aynı anda değişiklik yapmış; önizlemeyi yenileyip tekrar dağıtın. |
| Arayüzde saatler kaymış | Tanımlar → Fabrika ayarları → saat dilimi. |
| Giriş "çok fazla deneme" | 5 hatalı denemeden sonra 60 sn kilit (ve nginx'te IP başına dakikada 10 deneme). |

## Testler

| Takım | Komut | Kapsam |
|---|---|---|
| Sözleşmeler (TS) | `make test-ts` | Payload şemaları, UNS topic'leri, S7 adres doğrulama (TS/Python ortak test vektörleriyle) |
| Ingestion | `make test-ts` | Sayaç farkları (sıfırlanma/anomali), durum makinesi, duruş kayıtları |
| Ön yüz | `make test-ts` | Saat dilimi dönüşümleri, biçimlendirme |
| Simülatör, API birim | `make test-py` | S7 protokol gidiş-dönüş, akış üretici, OEE motoru (elle hesaplanmış senaryolar, yaz saati), zamanlayıcı |
| API entegrasyon | `make test-api-int` | Gerçek MSSQL üzerinde kimlik doğrulama, roller, CRUD, iş emirleri, OEE uçtan uca, bakım işleri |
| Uçtan uca | `make e2e` | Tarayıcıdan: canlı panel, simülatör duruşu → arayüz, operatör, konfigüratör doğrulaması, raporlar, yetkiler |

## Proje yapısı

```
apps/
  api/          FastAPI: kimlik doğrulama, CRUD, OEE motoru, raporlar, Node-RED akış üretici, bakım işleri
  ingestion/    Node.js: MQTT → MSSQL, sayaç farkları, durum makinesi, Socket.io
  web/          React arayüzü (nginx ile sunulur)
  simulator/    S7-1200/1500 simülatörü (python-snap7)
packages/
  contracts/    Paylaşılan veri sözleşmeleri (zod) + JSON Schema + ortak test vektörleri
db/             Migration aracı, migration'lar, örnek veri
infra/          EMQX ve Node-RED yapılandırması, sertifikalar (git dışı)
scripts/        Sertifika, yedekleme, geri yükleme
e2e/            Playwright uçtan uca testleri
```
