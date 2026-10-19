# IIoT & OEE Manufacturing Execution System (MES) — Mimari

> Sürüm: v1 (2026-10-19). İlk taslak `docs/ARCHITECTURE.v0-taslak.md` içinde saklanmaktadır.
> Bu dosya projenin tek referans kaynağıdır; kodla çelişen bir karar alındığında önce burası güncellenir.

---

## 1. Sistem Özeti

Uçtan uca bir Endüstriyel IoT veri toplama, canlı izleme ve OEE raporlama sistemi (monorepo).

```
 PLC (S7)  ──►  HUBBOX Connect X2  ──►  Node-RED  ──MQTT──►  EMQX  ──►  Ingestion (Node.js)
 (192.168.10.x)   (güvenli tünel)       (polling +            (UNS)        │  bulk insert
                                         normalize)                        ▼
                                                                     MS SQL Server (MES_DB)
                                                                           ▲        │
            React Web  ◄──── Socket.io (canlı) ──── Ingestion              │        │
                 │                                                         │        │
                 └──────── REST ────► Analitik API (FastAPI) ──────────────┘        │
                                           │                                        │
                                           └── Node-RED Admin API (akış deploy) ◄───┘
```

### 1.1. Kapsam (v1)
| Konu | Karar |
|---|---|
| PLC protokolü | **Yalnızca Siemens S7.** Akış üretici protokol bazında soyutlanır; Modbus/OPC UA sonradan "driver" olarak eklenir. |
| Çalışma durumu kaynağı | Makine bazında seçilir: **PLC durum tag'i** veya **sayaç hareketinden çıkarım** (eşik süresi ayarlanabilir). |
| Hurda kaynağı | Makine bazında seçilir: **PLC hurda sayacı** veya **operatör girişi**. |
| İdeal çevrim süresi | **Ürün × makine** eşleşmesinden; aktif iş emrinin ürününe göre uygulanır. |
| Yetkilendirme | JWT + roller: `admin`, `engineer`, `operator`, `viewer`. |
| Duruş & iş emri | Duruşlar otomatik açılır; operatör ekranından neden atanır. İş emirleri web arayüzünden yönetilir. |
| Test ortamı | Simülatör (gerçek S7 protokolü konuşan python-snap7 sunucusu) + fiziksel test PLC'si (S7-1200/1500). |

### 1.2. Kapsam dışı (v1)
Modbus/OPC UA, SSO/LDAP, çoklu fabrika (multi-tenant), ERP entegrasyonu, bakım (CMMS) modülü.

---

## 2. Teknoloji Yığını

| Katman | Teknoloji |
|---|---|
| Altyapı | Docker, Docker Compose, `.env` |
| Edge | Node-RED 5.0 + `node-red-contrib-s7` 3.1, HUBBOX Connect X2 arkasındaki PLC'ler |
| Broker | EMQX 5.8.9 — Apache 2.0 lisanslı son sürüm; 5.9+ BSL lisanslıdır (kullanıcı/şifre + topic ACL) |
| Ingestion & Real-time | Node.js 24 LTS (TypeScript), `mqtt`, `zod`, `mssql` (bulk API), `socket.io`, `pino` |
| Veritabanı | MS SQL Server 2022, veritabanı: `MES_DB` |
| Analitik API | Python 3.12, FastAPI, Pydantic v2, `pymssql`, `argon2-cffi`, `PyJWT` |
| Ön yüz | React + Vite + TypeScript, TailwindCSS, Recharts, Socket.io-client, Lucide-React, TanStack Query |
| Simülatör | Python 3.12, `python-snap7` 3.x S7 sunucusu (saf Python; native derleme gerektirmez) |
| Paket yönetimi | `pnpm` workspaces (TS projeleri), `uv` (Python) |

**Not (pymssql):** Sürücü senkron çalışır. FastAPI'de DB erişen endpoint'ler `async def` değil düz `def` olarak yazılır (FastAPI bunları threadpool'da çalıştırır) veya `run_in_threadpool` kullanılır.

---

## 3. Repo Yapısı

```
v-mes-2/
├── ARCHITECTURE.md
├── docker-compose.yml
├── .env.example
├── infra/
│   ├── emqx/              # ACL, kullanıcı bootstrap
│   └── nodered/           # settings.js (adminAuth), package.json (s7 node'ları)
├── db/
│   ├── migrations/        # Sıralı, idempotent T-SQL dosyaları (V001__init.sql ...)
│   └── seed/              # Geliştirme verisi
├── packages/
│   └── contracts/         # Paylaşılan zod şemaları + JSON Schema export (Python tarafı bundan üretilir)
├── apps/
│   ├── ingestion/         # MQTT → MSSQL, durum makinesi, Socket.io
│   ├── api/               # FastAPI: CRUD, OEE, akış üretici, auth
│   ├── web/               # React
│   └── simulator/         # S7 sunucu simülatörü
└── docs/
```

---

## 4. UNS (Unified Namespace) — ISA-95 Topic Standardı

```
factory/{area_slug}/{line_slug}/{machine_code}/telemetry   # periyodik tag değerleri (QoS 1)
factory/{area_slug}/{line_slug}/{machine_code}/status      # edge bağlantı durumu, retained (QoS 1)
factory/_edge/{edge_id}/heartbeat                          # Node-RED canlılık sinyali (QoS 0)
```

- Slug'lar: küçük harf, `[a-z0-9-]`. `machine_code` makine için benzersiz, değişmez bir kısa koddur (ör. `cnc-01`).
- Ingestion aboneliği: `factory/+/+/+/telemetry`, `factory/+/+/+/status`, `factory/_edge/+/heartbeat`.
- Topic'ten çıkan hiyerarşi ile payload'daki `machine_code` uyuşmazsa mesaj reddedilir (dead-letter).

### 4.1. Payload Sözleşmesi (`packages/contracts`)

```jsonc
// telemetry
{
  "v": 1,                              // şema sürümü
  "machine_code": "cnc-01",
  "ts": "2026-10-19T08:15:30.120Z",    // ISO-8601, UTC, Node-RED okuma zamanı
  "tags": { "total_count": 15230, "scrap_count": 12, "running": 1, "spindle_temp": 41.7 }
}

// status (retained)
{ "v": 1, "machine_code": "cnc-01", "ts": "...", "online": false, "error": "ECONNRESET" }
```

Tag değerleri sayı veya boolean'dır (boolean → 0/1 olarak saklanır). Sözleşme zod ile tanımlanır, JSON Schema'ya export edilir ve Python tarafında Pydantic modelleri buradan üretilir.

---

## 5. Veritabanı (`MES_DB`)

**Genel kurallar**
- Tüm zaman damgaları **UTC**, tip `datetime2(3)`. Vardiya/rapor hesapları `plant_settings.timezone` (ör. `Europe/Istanbul`) ile yerel saate çevrilir.
- Şema değişiklikleri yalnızca `db/migrations` üzerinden; uygulanan sürümler `dbo.schema_migrations` tablosunda izlenir.

### 5.1. Ana Veri (Master Data)
| Tablo | Önemli alanlar |
|---|---|
| `areas` | `id`, `slug`, `name` |
| `lines` | `id`, `area_id`, `slug`, `name` |
| `machines` | `id`, `line_id`, `code`, `name`, `is_active`, `state_source` (`tag` \| `counter`), `counter_idle_seconds`, `scrap_source` (`plc` \| `manual`) |
| `machine_plc_configs` | `machine_id`, `protocol` (`s7`), `host`, `port`, `rack`, `slot`, `poll_ms`, `tags_json`, `updated_at` |
| `products` | `id`, `code`, `name` |
| `product_machine_rates` | `product_id`, `machine_id`, `ideal_cycle_seconds` |
| `shift_definitions` | `id`, `name`, `start_local`, `end_local`, `days_mask` (gece yarısını aşan vardiya desteklenir) |
| `planned_stop_definitions` | Mola/yemek gibi tekrarlı planlı duruşlar (vardiyaya bağlı) |
| `downtime_reasons` | `id`, `code`, `name`, `category` (`unplanned` \| `planned` \| `changeover` …), `parent_id` |
| `users` | `id`, `username`, `password_hash` (argon2), `role`, `is_active` |

**`tags_json` yapısı** (her eleman):
```json
{ "name": "total_count", "address": "DB1,DINT2", "role": "total_count", "unit": "pcs" }
```
`role` değerleri: `total_count`, `scrap_count`, `running` (durum), `state_code`, `process` (serbest analog/dijital değer). Bir makinede `total_count` zorunludur; `state_source = 'tag'` ise `running` veya `state_code`, `scrap_source = 'plc'` ise `scrap_count` zorunludur. Adres formatı `node-red-contrib-s7` sözdizimini izler (`DB<no>,<TİP><bayt>[.<bit>]`; tipler X, BYTE, INT, WORD, DINT, DWORD, REAL). v1'de yalnızca DB adresleri desteklenir. Sayaç rolleri yalnızca DINT/DWORD/WORD olabilir: işaretli INT taşınca negatife düşer ve sıfırlanmadan ayırt edilemez. Kurallar `packages/contracts/src/plc.ts` içindedir.

### 5.2. Operasyonel Veri
| Tablo | Önemli alanlar |
|---|---|
| `production_orders` | `id`, `order_no`, `product_id`, `machine_id`, `target_qty`, `status` (`planned` \| `running` \| `paused` \| `done` \| `cancelled`), `started_at`, `ended_at`. Makine başına tek `running` iş emri (filtreli unique index). |
| `production_order_runs` | İş emrinin gerçekten çalıştığı aralıklar (duraklat/devam). Performance hesabında hangi zamanda hangi ürünün geçerli olduğunu belirler. |
| `machine_state_intervals` | `machine_id`, `state` (`running` \| `stopped` \| `offline`), `start_ts`, `end_ts` (açık aralıkta NULL) |
| `downtime_logs` | `id`, `machine_id`, `start_ts`, `end_ts`, `reason_id` (NULL = atanmamış), `assigned_by`, `note` |
| `manual_scrap_entries` | `machine_id`, `production_order_id`, `ts`, `qty`, `reason`, `entered_by` |

### 5.3. Zaman Serisi
| Tablo | Açıklama |
|---|---|
| `machine_telemetry` | Ham veri, **long format**: `machine_id int`, `tag_name varchar(64)`, `ts datetime2(3)`, `value float`. `CLUSTERED COLUMNSTORE INDEX`, aylık partition. |
| `counter_deltas_1m` | Dakikalık sayaç artışları: `machine_id`, `bucket_ts`, `role`, `delta`. Ingestion tarafından yazılır; OEE sorguları buradan beslenir. Rowstore, `(machine_id, bucket_ts)` clustered. |
| `counter_state` | Makine × sayaç rolü için son değer. Ingestion yeniden başladığında fark hesabına buradan devam eder. |
| `ingest_dead_letters` | Doğrulamadan geçemeyen mesajlar (topic, payload, hata, ts). 7 gün saklanır. |

**Columnstore bakımı:** Ingestion küçük batch'ler yazdığı için satırlar önce delta store'a düşer. Gece çalışan bir job `ALTER INDEX ... REORGANIZE` ile kapalı rowgroup'ları sıkıştırır. Ham telemetri için saklama süresi `plant_settings.raw_retention_days` (varsayılan 180 gün) ile partition switch-out yöntemiyle temizlenir; `counter_deltas_1m` süresiz tutulur.

---

## 6. Ingestion Servisi (`apps/ingestion`)

1. **Doğrulama:** Her mesaj zod ile doğrulanır; topic ↔ payload tutarlılığı kontrol edilir. Hatalı mesaj → `ingest_dead_letters`.
2. **Tamponlama:** Satırlar bellekte biriktirilir; **1 sn veya 5.000 satır** (hangisi önce gelirse) dolunca `mssql` bulk insert ile yazılır. Yazma başarısızsa üstel geri çekilmeyle yeniden denenir; tampon üst sınırı aşılırsa en eski veri atılır ve metrik/log üretilir.
3. **Sayaç farkları (diferansiyel hesap):** Her makine × sayaç rolü için son değer bellekte tutulur ve `counter_state` tablosuna yazılır (servis açılışında buradan yüklenir).
   - `d = yeni − önceki`
   - `d ≥ 0` → artış olarak eklenir.
   - `d < 0` → **sayaç sıfırlanması/taşması** kabul edilir; artış = `yeni` (sıfırdan yeniden saydığı varsayılır) ve olay loglanır.
   - Farklar dakikalık kovalara toplanıp `counter_deltas_1m` tablosuna upsert edilir.
   - Böylece raporlarda `SUM(ham sayaç)` veya `max − min` hiçbir zaman kullanılmaz; sıfırlanmalar ve pencere sınırları doğru ele alınır.
4. **Durum makinesi:** Makine bazında `running` / `stopped` / `offline` hesaplanır.
   - `state_source = 'tag'`: `running` tag'i (0 dışı = çalışıyor). Yoksa `state_code` (yalnızca `1` = çalışıyor; `0` beklemede, diğer kodlar arıza/duruş nedeni). İkisi birden varsa `running` önceliklidir.
   - `state_source = 'counter'`: `total_count` son `counter_idle_seconds` saniyedir artmadıysa `stopped`.
   - `offline`: `status.online = false` veya `3 × poll_ms` (min. 30 sn) boyunca telemetri gelmemesi.
   - Her geçişte `machine_state_intervals` kapatılır/açılır. `running → stopped` geçişinde `downtime_logs`'a nedeni boş bir kayıt açılır; tekrar `running` olunca kapatılır.
   - Mikro duruşlar: `plant_settings.min_downtime_seconds` (varsayılan 60 sn) altındaki duruşlar downtime kaydı açmaz ama durum aralığında görünür (Performance kaybına yansır).
5. **Canlı yayın (Socket.io):** Bağlantı JWT ile doğrulanır (`handshake.auth.token`; HS256, `JWT_SECRET` API ile paylaşılır; zorunlu claim'ler: `sub`, `role`, `type: "access"`). İstemci `subscribe { room }` ile `plant`, `line:{id}` veya `machine:{id}` odalarına katılır. Bağlanınca `snapshot` (tüm makinelerin durumu + son telemetri + edge durumu) gönderilir. Canlı olaylar: `telemetry` (makine başına en fazla 1/sn), `state`, `downtime_opened`, `downtime_closed`, `edge`.
6. **Sağlık:** `GET /health` → MQTT/DB bağlantısı, tampon boyutu, son yazım zamanı, reddedilen/tekrarlanan mesaj sayıları.

---

## 7. Edge Katmanı: Cihaz Kaydı ve Akış Üretimi

### 7.1. İş Akışı
1. **Kayıt/Güncelleme:** Web arayüzü (Zero-Code PLC konfigüratörü) veya REST API ile makine, bağlantı ve tag bilgileri girilir. API adres sözdizimini ve zorunlu rolleri doğrular.
2. **Doğrulama:** `POST /api/machines/{id}/plc/validate` kaydetmeden doğrular (adres sözdizimi, rol-tip uyumu, zorunlu roller, çakışan adres uyarıları); konfigüratördeki anlık geri bildirim içindir. Adresler kanonik biçimde saklanır (`db1,di4` → `DB1,DINT4`).
   - **Bağlantı testi** (`POST /api/machines/{id}/plc/test`, Node-RED üzerinden tek seferlik okuma) fiziksel test PLC'si hazır olduğunda, son aşamada eklenecektir.
3. **Akış üretimi:** Aktif makineler taranır, her **hat (line)** için ayrı bir Node-RED sekmesi (flow tab) üretilir. Sekme ID'leri deterministiktir (`mes-line-{line_id}`), böylece yeniden üretimde aynı sekme güncellenir.
   - Makine başına: `s7 endpoint` (config), `s7 in` (tüm değişkenler, `poll_ms`), normalizasyon `function` (payload sözleşmesini üretir), `mqtt out`.
   - Makine başına durum izleme: `s7 in` düğümünün durum değişiklikleri (`status` düğümü) ve ilk başarılı okuma, `status` topic'ine retained olarak yayınlanır. (S7 düğümünün ilk durum olayı akış başlarken kaçabildiği için normalize fonksiyonu da ilk okumada `online: true` yayınlar.)
   - Heartbeat ayrı bir edge sekmesindedir (`mes-edge-{edge_id}`): `inject` (10 sn) → `factory/_edge/{edge_id}/heartbeat`.
   - MQTT kullanıcı bilgileri akışa `${MQTT_USER}` / `${MQTT_PASSWORD}` ortam değişkeni referansı olarak yazılır; şifreler akış JSON'ına ve API'ye girmez.
4. **Önizleme:** `GET /api/flows/preview` — deploy edilecek JSON ve mevcut durumla farkı (eklenen/değişen/silinen makineler) döner.
5. **Deploy (sıfır kesinti):** `POST /api/flows/deploy` (yalnızca `admin`/`engineer`).
   - Mevcut akış `GET /flows` (API v2, `rev` ile) okunur; `mes-` önekli yönetilen sekmeler/düğümler yenileriyle değiştirilir, kullanıcının sekmelerine dokunulmaz.
   - Sonuç **`POST /flows`** ile `Node-RED-Deployment-Type: flows` başlığı ve okunan `rev` ile gönderilir. Node-RED yalnızca içeriği değişen sekmeleri yeniden başlatır; diğer hatların PLC bağlantıları kopmaz. Arada başkası deploy ettiyse `409` döner ve işlem tekrarlanır.
   - (`POST /flow` kullanılmaz: Node-RED verilen sekme ID'sini yok sayıp yeni ID üretir; deterministik ID'ler bozulur.)
   - Değişiklik yoksa deploy atlanır. Artık aktif olmayan hatların sekmeleri aynı işlemde kaldırılır.
   - İçeriği değişmeyen sekmeler için Node-RED'in mevcut düğümleri aynen geri gönderilir. Yeni üretilen düğümler credentials içerdiği için Node-RED onları (aynı değerle bile) değişmiş sayar ve o sekmenin MQTT bağlantısını yeniden kurar; bu yöntemle yalnızca gerçekten değişen hat etkilenir.
   - Kalıcılık Node-RED'in kendi `flows.json` dosyası üzerinden sağlanır; ayrıca dosyaya yazılmaz.
   - Her deploy `flow_deployments` tablosuna (kim, ne zaman, özet, sonuç) kaydedilir.

### 7.2. S7 PLC Gereksinimleri (S7-1200/1500)
- Okunan DB'lerde **"Optimized block access" kapalı** olmalı (mutlak adresleme için).
- CPU ayarlarında **"Permit access with PUT/GET communication" açık** olmalı.
- Rack/slot: S7-1200/1500 için genelde `0/1`, S7-300 için `0/2`.

---

## 8. Ağ, HUBBOX ve Güvenlik

- PLC'ler izole makine ağındadır (`192.168.10.x`) ve dışarıya kapalıdır. Node-RED bu ağa yalnızca HUBBOX Connect X2'nin sağladığı tünel/rota üzerinden erişir. PLC'ye yazma yapılmaz; sistem **salt okunurdur**.
- **Edge watchdog:** Ingestion heartbeat'i izler; `edge_heartbeat_timeout_seconds` (30 sn) boyunca heartbeat gelmezse `edge` olayıyla arayüzde uyarı gösterilir. Makinelerin `offline` durumu ise makine bazında belirlenir (status mesajı veya telemetri zaman aşımı); böylece edge'in tamamen düşmesi ile tek bir PLC'nin kopması ayırt edilir.
- **EMQX:** Anonim erişim kapalı. Servis başına kullanıcı ve ACL: Node-RED yalnızca `factory/#` yayınlayabilir; ingestion yalnızca abone olabilir. Üretimde TLS (8883).
- **Node-RED:** `adminAuth` açık; editör ve Admin API yalnızca iç ağdan erişilebilir. API servisi Admin API'ye servis hesabıyla bağlanır.
- **Uygulama yetkileri:**

| İşlem | admin | engineer | operator | viewer |
|---|:-:|:-:|:-:|:-:|
| Kullanıcı yönetimi | ✓ | | | |
| Makine / PLC konfigürasyonu, akış deploy | ✓ | ✓ | | |
| Ürün, vardiya, duruş nedeni tanımları | ✓ | ✓ | | |
| İş emri başlat/bitir, duruş nedeni ata, hurda gir | ✓ | ✓ | ✓ | |
| Canlı izleme ve raporlar | ✓ | ✓ | ✓ | ✓ |

- JWT: kısa ömürlü access token (15 dk, HS256; claim'ler `sub`, `name`, `role`, `type: "access"`) + refresh token (httpOnly, `SameSite=Strict`, `path=/api/auth` çerezi; veritabanında yalnızca SHA-256 hash'i saklanır).
  - Refresh token her kullanımda yenilenir (rotasyon). Kullanılmış bir token tekrar gelirse çalınmış sayılır ve kullanıcının tüm oturumları kapatılır.
  - Rol değişikliği, şifre değişikliği ve pasifleştirme mevcut oturumları kapatır. Sistemde en az bir aktif admin kalması zorunludur.
  - Kullanıcı adı başına kaba kuvvet koruması: 5 hatalı denemeden sonra 60 sn kilit. Şifre politikası: en az 10 karakter, büyük/küçük harf ve rakam.
  - Sistemde hiç kullanıcı yoksa API ilk açılışta `ADMIN_USERNAME` / `ADMIN_PASSWORD` ile admin hesabı oluşturur.
- Şifreler argon2id ile saklanır.
- Gizli bilgiler yalnızca `.env` / Docker secrets içinde tutulur, repoya girmez.

---

## 9. OEE Hesaplama İlkeleri

Tüm bileşenler **0–1 arası oran** olarak hesaplanır; yalnızca arayüzde yüzde olarak gösterilir.

```
Vardiya Süresi    = Pencere ∩ vardiya aralıkları (gelecek hariç)
Planlı Süre       = Vardiya süresi − planlı duruş tanımları − "planned" kategorili duruşlar − verisiz süre
Çalışma Süresi    = Planlı Süre − plansız duruşlar (unplanned + changeover + nedeni atanmamış)

Availability (A)  = Çalışma Süresi / Planlı Süre
Performance  (P)  = Σ (ideal_cycle_seconds × adet) / Çalışma Süresi      # ürün değişimlerine göre parça parça
Quality      (Q)  = İyi Adet / Toplam Adet,   İyi Adet = Toplam − Hurda
OEE               = A × P × Q
```

- **Kullanılabilirlik kaybı yalnızca kayıtlı duruşlardan** (`downtime_logs`, ≥ `min_downtime_seconds`) gelir. Mikro duruşlar çalışma süresinde kalır ve performans kaybı olarak görünür.
- **Nedeni atanmamış duruşlar** plansız sayılır (operatör neden atayana kadar). Operatör "planned" kategorili bir neden atarsa o süre planlı süreden düşülür.
- **Verisiz süre** (vardiya içinde hiç durum aralığı olmayan zaman; ör. ingestion veya edge kapalıyken) makineye ne kayıp ne kazanç yazılır: planlı süreden düşülür, `no_data_seconds` olarak raporlanır ve uyarı üretilir.
- **Adetler** yalnızca `counter_deltas_1m` toplamından gelir (bkz. §6.3). Dakika kovası, başlangıcı planlı sürede ise OEE'ye dahildir; planlı süre dışındaki üretim `off_plan_count` olarak ayrıca raporlanır. Hurda: `scrap_source = 'plc'` ise sayaç farkı, `manual` ise `manual_scrap_entries` toplamı (toplam adetle sınırlı).
- **İdeal çevrim süresi**, ilgili dakikada makinede çalışan iş emrinin (`production_order_runs`) ürününe göre `product_machine_rates` tablosundan alınır. İş emri olmadan veya çevrim süresi tanımsız üretilen adet varsa (`unattributed_count`) Performance ve OEE `null` döner ve uyarı üretilir (sessizce 0 veya 1 yazılmaz).
- Hiç üretim yoksa Quality tanımsızdır (`null`) ama OEE sıfırdır (P = 0).
- P > 1 çıkarsa değer raporlanır ve uyarı gösterilir; kırpılmaz.
- **Toplama** (hat/alan/fabrika, çok dönemli özet) süre ve adetlerin toplanmasıyla yapılır; makine oranlarının ortalaması alınmaz.
- **Kayıp şelalesi** (saniye): planlı süre → çalışma (kullanılabilirlik kaybı) → net çalışma = Σ ideal × toplam (performans kaybı) → tam verimli = Σ ideal × iyi (kalite kaybı).
- **Dönemler** (`group_by`: hour, shift, day, week) fabrika yerel saatine göre ve yaz saati geçişlerine dayanıklı hesaplanır (yaz saati bitiş günü 25 saat).
- Hesaplar `apps/api` içindeki tek bir OEE modülünde yapılır; aynı fonksiyon hem rapor endpoint'lerini hem canlı vardiya özetini besler. Birim testleri sayaç sıfırlanması, gece yarısını aşan vardiya, iş emri değişimi ve veri boşluğu senaryolarını kapsar.

---

## 10. Analitik API (`apps/api`) — Uç Noktalar (özet)

```
POST   /api/auth/login | /api/auth/refresh | /api/auth/logout
CRUD   /api/areas, /api/lines, /api/machines, /api/products, /api/shifts, /api/downtime-reasons, /api/users
GET    /api/hierarchy                   (alan → hat → makine ağacı)
PUT    /api/products/{id}/rates         GET/PATCH /api/settings
GET    /api/auth/me                     /api/docs (OpenAPI)
GET/PUT /api/machines/{id}/plc          POST /api/machines/{id}/plc/validate   (POST .../plc/test → aşama 7)
GET    /api/flows/preview               POST /api/flows/deploy        GET /api/flows/deployments
CRUD   /api/production-orders           POST /api/production-orders/{id}/start|pause|complete|cancel
GET    /api/downtimes?machine_id&line_id&from&to&unassigned
PATCH  /api/downtimes/{id}              (neden atama + not)
GET/POST /api/scrap                     DELETE /api/scrap/{id} (engineer+)
GET    /api/operator/machines/{id}      (aktif iş emri, kuyruk, nedeni atanmamış duruşlar — tek çağrı)

# Raporlar — ortak parametreler: scope=plant|area|line|machine, id, from/to (ISO-8601) veya
# preset=current_shift|today|yesterday|last_24h|last_7_days|this_week|this_month, format=json|csv
GET    /api/oee?group_by=none|hour|shift|day|week&breakdown=none|machine|line
GET    /api/oee/live                    (mevcut vardiya, makine başına)
GET    /api/reports/downtime-pareto     (azalan sıralı, kümülatif pay; "Nedeni atanmamış" dahil)
GET    /api/reports/state-timeline      (gantt: durum aralıkları + duruşlar + vardiyalar)
GET    /api/reports/production?group_by=...
GET    /api/telemetry?machine_id&tags&max_points (otomatik zaman kovası: avg/min/max/n)
```

- CSV çıktıları `;` ayraçlı ve UTF-8 BOM'ludur (Excel Türkçe karakterleri doğru açar).
- Tüm zaman damgaları UTC ISO-8601 (`Z`) döner; dönem etiketleri yerel saattir. Yanıtlar `window` alanında çözümlenen aralığı ve saat dilimini içerir.
- İş emri ilerlemesi: üretilen/hurda/iyi adet, hedefe oran ve kalan ideal süre, iş emrinin çalıştığı aralıklardaki sayaç farklarından hesaplanır. Bir makinede aynı anda tek iş emri çalışabilir.

Büyük zaman aralıklarında `/api/telemetry` ham veriyi doğrudan döndürmez; aralığa göre zaman kovalarında (`avg/min/max`) özetleyerek en fazla ~2.000 nokta döner.

---

## 11. Ön Yüz (`apps/web`)

### 11.1. Ekranlar
| Ekran | Rol | İçerik |
|---|---|---|
| **Canlı Panel** | herkes | Fabrika → alan → hat → makine kırılımı; makine kartlarında durum rengi, anlık hız, vardiya OEE'si, aktif iş emri, açık duruş süresi. Socket.io ile canlı. |
| **Makine Detayı** | herkes | Durum zaman çizelgesi (gantt), canlı tag grafikleri, vardiya OEE dağılımı, son duruşlar. |
| **Raporlar** | herkes | Bkz. §11.2. |
| **Operatör Ekranı** | operator+ | Tablete uygun, büyük dokunmatik butonlar: açık duruşa neden ata, iş emri başlat/bitir, hurda gir. Tek makine veya hat seçilerek sabitlenir. |
| **PLC Konfigüratörü** | engineer+ | Hiyerarşi ağacı, makine formu, tag tablosu (rol seçimi, adres doğrulama), bağlantı testi, akış önizleme (fark görünümü) ve deploy. |
| **Tanımlar** | engineer+ | Ürünler ve çevrim süreleri, vardiyalar, planlı duruşlar, duruş nedenleri. |
| **Kullanıcılar** | admin | Kullanıcı ve rol yönetimi. |

### 11.2. Raporlama Ekranları — Tasarım İlkeleri
Hedef: **etkileyici ama sade.** Her grafik tek bir soruyu net cevaplar; süs yerine veri öne çıkar.

**Grafik türü seçimi**
- Her rapor kartının köşesinde bir **grafik türü seçici** bulunur. Seçenekler verinin yapısına göre **filtrelenir**; anlamsız kombinasyonlar sunulmaz. Her kartta ayrıca **tablo görünümü** (erişilebilir eşdeğer), CSV indirme ve tam ekran vardır.

| Veri | Varsayılan | Seçilebilir türler |
|---|---|---|
| Zaman içinde OEE / A / P / Q | Çizgi (4 seri, tek eksen %0–100) | Alan (OEE), sütun (OEE), A / P / Q ayrı küçük grafikler |
| OEE özeti | KPI kartları + ilerleme çubuğu (OEE kahraman sayı) | — (tek sayı için grafik kullanılmaz) |
| Makine/hat karşılaştırması | Yatay sütun, OEE'ye göre sıralı | A / P / Q gruplu, tablo |
| Duruş nedenleri | Pareto: sıralı yatay sütun + kümülatif pay sütunu; %80'e kadar olanlar vurgulu | Ağaç harita, tablo |
| OEE kayıp dağılımı | Şelale (planlı → çalışma → net → tam verimli) | Yığılmış tek çubuk |
| Makine × saat/gün | Isı haritası (tek ton mavi, 7 sınıf) | Tablo |
| Durum geçmişi | Zaman çizelgesi (gantt) + duruş şeridi + mola bantları | — |
| Üretim adedi | Yığılmış sütun (iyi + hurda) | Çizgi, kümülatif alan |
| Proses tag'leri | Çizgi | Min–maks bandı, nokta |

- **Çift eksenli grafik kullanılmaz.** Klasik Pareto'daki "sütun + kümülatif % çizgisi" ve "sütun + çizgi birleşik" grafikleri iki farklı ölçeği üst üste bindirip olmayan bir ilişki izlenimi verdiği için yerine sırasıyla kümülatif pay sütunu ve küçük çoklu grafikler kullanılır. Farklı birimli tag'ler ayrı grafiklerde gösterilir.
- Seçilen grafik türü, filtreler ve zaman aralığı **URL'de** saklanır (paylaşılabilir bağlantı); son seçilen tür ayrıca kullanıcı tercihi olarak hatırlanır.

**Görsel dil**
- Renkler veri görselleştirme rehberinin **doğrulanmış referans paletinden** gelir (kategorik sıra renk körlüğüne göre doğrulanmıştır; sıra değiştirilmez). Seri rengi varlığa bağlıdır, sıraya değil.
- Durum renkleri tüm uygulamada sabit: çalışıyor = yeşil, duruyor = kırmızı, planlı duruş = mavi, bağlantı yok = gri, ürün/takım değişimi = sarı, nedeni girilmemiş = turuncu. Renk tek başına bilgi taşımaz; **her zaman ikon + etiketle** birlikte kullanılır.
- İnce işaretler (çizgi 2 px, çubuk ≤ 24 px, yuvarlatılmış uç), düz ve silik ızgara, yığın segmentleri arasında zemin rengi boşluk. Metin hiçbir zaman seri renginde değildir. 2+ seri varsa lejant her zaman vardır.
- Açık/koyu tema: koyu tema otomatik ters çevirme değil, aynı tonların koyu zemin için seçilmiş adımlarıdır. Sistem tercihi + kullanıcı seçimi (sistem / açık / koyu).
- Veri olmayan dönemler sıfırla doldurulmaz: ısı haritasında "planlı üretim / veri yok" taralı, "OEE hesaplanamadı" (ör. iş emri yok) ayrı işaretle gösterilir; karşılaştırmada çubuk yerine nedeni yazılır.
- Yenilemede iskelet yanıp sönmez; önceki çizim soluklaşarak korunur.

**Etkileşim**
- Üstte yapışkan, tek filtre çubuğu: kapsam (fabrika / alan / hat / makine), zaman aralığı (bu vardiya, bugün, dün, son 7 gün, bu ay, özel), dönem (saat / vardiya / gün / hafta).
- **Karşılaştırma modu:** KPI kartlarında aynı uzunluktaki önceki döneme göre puan farkı.
- Detaya inme: karşılaştırmada hat ↔ makine geçişi; Pareto çubuğuna tıklayınca o nedene ait duruş kayıtları; zaman çizelgesinde duruşa tıklayınca neden atama (operatör+).
- Her kartta CSV dışa aktarma ve tam ekran (Esc ile çıkış).

**Teknik**
- Recharts (çizgi, alan, sütun, şelale, ağaç harita); ısı haritası ve gantt özel HTML bileşenleridir. Tüm grafikler ortak `ChartCard` sarmalayıcısı (başlık, tür seçici, tablo görünümü, yükleniyor/boş/hata durumu, CSV, tam ekran) içinde kullanılır.
- Canlı veri Socket.io deposundan (`useSyncExternalStore`) gelir; REST verisi TanStack Query ile önbelleklenir. Access token yalnızca bellekte tutulur; sayfa yenilendiğinde refresh çereziyle oturum geri yüklenir.
- Ön yüz nginx konteynerinde sunulur; `/api` ve `/socket.io` aynı origin üzerinden API ve ingestion'a yönlendirilir (CORS ve çerez sorunları yoktur). Güvenlik başlıkları (CSP, X-Frame-Options vb.) nginx tarafından eklenir.
- Tarih/saatler her zaman fabrika saat diliminde gösterilir (tarayıcının saat diliminden bağımsız).

---

## 12. Simülatör (`apps/simulator`)

- Her simüle makine için ayrı portta gerçek S7 protokolü konuşan bir sunucu (python-snap7) açar; böylece Node-RED akışları simülatör ve gerçek PLC için **aynıdır**. Makineler `apps/simulator/machines.yaml` içinde tanımlanır.
- Kontrol API'si (geliştirme/test): `GET /machines`, `POST /machines/{code}/stop?seconds=`, `/resume`, `/reset-counters`, `/disconnect?seconds=`.
- Konfigüre edilebilir senaryolar: normal üretim, rastgele duruşlar, mikro duruşlar, hurda oranı, **sayaç sıfırlanması**, bağlantı kopması, yavaş çalışma (Performance kaybı).
- Simüle makinelerin DB düzeni seed verisindeki `tags_json` ile birebir eşleşir.

---

## 13. Operasyon

Ayrıntılı kurulum ve işletim talimatları: **README.md**.

- Compose proje adı `v-mes-2`'dir. Aynı makinedeki eski `../v-mes` projesiyle konteyner ve port çakışmasını önlemek için bu ad değiştirilmemelidir; yerel `.env` dosyasında farklı host portları kullanılır.
- Günlük komutlar `Makefile` içindedir; Node.js/Python yerelde kurulu olmasa da tüm derleme ve testler Docker içinde çalışır.
- **Ortamlar:** `docker-compose.yml` (geliştirme; `dev` profili simülatörü başlatır) + `docker-compose.prod.yml` katmanı (üretim):
  - Web yalnızca HTTPS (nginx TLS 1.2/1.3, HTTP/2, HSTS; 80 → 443). Refresh çerezi `Secure`.
  - MSSQL, Node-RED editörü ve EMQX paneli yalnızca `127.0.0.1`; API/ingestion portları kapalı (web üzerinden erişilir).
  - Saha edge'leri broker'a MQTT TLS (8883) ile bağlanır: `FLOW_MQTT_TLS=true` olduğunda akış üretici her sekmeye `tls-config` düğümü ekler (CA yolu `${MQTT_CA_FILE}` ortam değişkeninden).
  - Sertifikalar `infra/certs/` altında (git dışı); test için `scripts/gen-certs.sh`.
- **Güvenlik başlıkları** (CSP, X-Frame-Options, nosniff, Referrer-Policy) nginx'te; giriş uç noktasında IP başına dakikada 10 istek sınırı (API'deki kullanıcı adı bazlı kilide ek).
- **Zamanlanmış bakım işleri** API süreci içinde çalışır; `sp_getapplock` ile çok örnekli dağıtımda tek örnekte yürür, durumu `dbo.job_runs`'ta tutulur (`/api/admin/jobs`): saatlik partition garantisi; gece (`maintenance_hour_local`, varsayılan 02:00) saklama süresi temizliği, columnstore sıkıştırma, oturum temizliği.
- **Yedekleme:** `scripts/backup.sh` (CHECKSUM + RESTORE VERIFYONLY ile doğrulanır, `BACKUP_KEEP_DAYS` saklama); `scripts/restore.sh … --yes` yazan servisleri durdurup geri yükler ve uygulama kullanıcısını yeniden eşler. Yedekler `./backups` klasörüne (MSSQL konteynerinde `/var/opt/mssql/backup`) yazılır.
- Her servis sağlık uç noktası sunar; compose healthcheck'leri bunlara bağlıdır. Tüm servislerde log döndürme (json-file, 5 × 10 MB).
- Ingestion ve API veritabanı/broker bağlantısı koptuğunda kendiliğinden yeniden bağlanır; ingestion veri yazılamazken tamponlar (üst sınırlı) ve kalıcı MQTT oturumu sayesinde kısa kesintilerde QoS 1 mesajlar broker'da bekler.
- Şema değişiklikleri yalnızca yeni bir `db/migrations/V###__ad.sql` dosyasıyla yapılır. Uygulanmış bir dosya değiştirilirse migration aracı durur. `DB_RESET` yalnızca adı `_TEST` ile biten veritabanlarında çalışır.

---

## 14. Geliştirme Aşamaları

| # | Aşama | Çıktı |
|---|---|---|
| 1 | Temel altyapı | Monorepo, docker-compose, DB migration'ları, `contracts` paketi |
| 2 | Veri hattı | Simülatör → Node-RED → EMQX → ingestion → MSSQL; sayaç farkları, durum makinesi, Socket.io |
| 3 | Konfigürasyon | FastAPI auth + roller, ana veri CRUD, PLC doğrulama, akış önizleme/deploy uç noktaları |
| 4 | OEE motoru | Vardiya, ürün, iş emri, duruş, hurda; OEE ve rapor endpoint'leri + birim testleri |
| 5 | Ön yüz | Canlı panel, makine detayı, operatör ekranı, konfigüratör, raporlar |
| 6 | Sağlamlaştırma | TLS, retention/partition job'ları, uçtan uca testler, dokümantasyon |
| 7 | Saha doğrulaması | Fiziksel S7-1200/1500 test PLC'si ile bağlantı, PLC bağlantı testi uç noktası, gerçek adreslerle akış doğrulaması |
