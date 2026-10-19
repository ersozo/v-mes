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
| Test ortamı | Simülatör (gerçek S7 protokolü konuşan snap7 sunucusu) + fiziksel test PLC'si. |

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
| Simülatör | Node.js / TypeScript, S7 sunucusu (snap7 tabanlı) |
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
   - `state_source = 'tag'`: `running` (veya `state_code`) tag değeri.
   - `state_source = 'counter'`: `total_count` son `counter_idle_seconds` saniyedir artmadıysa `stopped`.
   - `offline`: `status.online = false` veya `3 × poll_ms` (min. 30 sn) boyunca telemetri gelmemesi.
   - Her geçişte `machine_state_intervals` kapatılır/açılır. `running → stopped` geçişinde `downtime_logs`'a nedeni boş bir kayıt açılır; tekrar `running` olunca kapatılır.
   - Mikro duruşlar: `plant_settings.min_downtime_seconds` (varsayılan 60 sn) altındaki duruşlar downtime kaydı açmaz ama durum aralığında görünür (Performance kaybına yansır).
5. **Canlı yayın (Socket.io):** Bağlantı JWT ile doğrulanır. Odalar: `machine:{id}`, `line:{id}`, `plant`. Yayınlanan olaylar: `telemetry` (kısıtlanmış, makine başına en fazla 1/sn), `state`, `downtime_opened`, `downtime_closed`.

---

## 7. Edge Katmanı: Cihaz Kaydı ve Akış Üretimi

### 7.1. İş Akışı
1. **Kayıt/Güncelleme:** Web arayüzü (Zero-Code PLC konfigüratörü) veya REST API ile makine, bağlantı ve tag bilgileri girilir. API adres sözdizimini ve zorunlu rolleri doğrular.
2. **Bağlantı testi (opsiyonel):** `POST /api/machines/{id}/plc/test` — API, Node-RED üzerinden tek seferlik okuma yaptırır ve sonucu döner.
3. **Akış üretimi:** Aktif makineler taranır, her **hat (line)** için ayrı bir Node-RED sekmesi (flow tab) üretilir. Sekme ID'leri deterministiktir (`mes-line-{line_id}`), böylece yeniden üretimde aynı sekme güncellenir.
   - Makine başına: `s7 endpoint` (config), `s7 in` (tüm değişkenler, `poll_ms`), normalizasyon `function` (payload sözleşmesini üretir), `mqtt out`.
   - Makine başına durum izleme: `s7 endpoint` durum değişiklikleri `status` topic'ine retained olarak yayınlanır.
   - Sekme başına heartbeat `inject` düğümü (10 sn) → `factory/_edge/{edge_id}/heartbeat`.
4. **Önizleme:** `GET /api/flows/preview` — deploy edilecek JSON ve mevcut durumla farkı (eklenen/değişen/silinen makineler) döner.
5. **Deploy (sıfır kesinti):** `POST /api/flows/deploy` (yalnızca `admin`/`engineer`).
   - Her hat sekmesi Node-RED Admin API'sinin **`PUT /flow/{id}`** (yoksa `POST /flow`) uç noktasıyla tek tek güncellenir. Böylece yalnızca değişen hattın bağlantıları yeniden başlar; diğer hatlar ve kullanıcının elle eklediği sekmeler etkilenmez.
   - Artık aktif olmayan hatların sekmeleri `DELETE /flow/{id}` ile kaldırılır.
   - Kalıcılık Node-RED'in kendi `flows.json` dosyası üzerinden sağlanır; ayrıca dosyaya yazılmaz.
   - Her deploy `flow_deployments` tablosuna (kim, ne zaman, özet, sonuç) kaydedilir.

### 7.2. S7 PLC Gereksinimleri (S7-1200/1500)
- Okunan DB'lerde **"Optimized block access" kapalı** olmalı (mutlak adresleme için).
- CPU ayarlarında **"Permit access with PUT/GET communication" açık** olmalı.
- Rack/slot: S7-1200/1500 için genelde `0/1`, S7-300 için `0/2`.

---

## 8. Ağ, HUBBOX ve Güvenlik

- PLC'ler izole makine ağındadır (`192.168.10.x`) ve dışarıya kapalıdır. Node-RED bu ağa yalnızca HUBBOX Connect X2'nin sağladığı tünel/rota üzerinden erişir. PLC'ye yazma yapılmaz; sistem **salt okunurdur**.
- **Edge watchdog:** Ingestion heartbeat'i izler; `30 sn` heartbeat gelmezse ilgili edge'e bağlı tüm makineler `offline` işaretlenir ve arayüzde uyarı gösterilir. Tek bir PLC'nin kopması makine düzeyinde `status` mesajıyla ayırt edilir.
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

- JWT: kısa ömürlü access token (15 dk) + refresh token (httpOnly cookie). Şifreler argon2id ile saklanır.
- Gizli bilgiler yalnızca `.env` / Docker secrets içinde tutulur, repoya girmez.

---

## 9. OEE Hesaplama İlkeleri

Tüm bileşenler **0–1 arası oran** olarak hesaplanır; yalnızca arayüzde yüzde olarak gösterilir.

```
Planlı Süre       = Pencere içindeki vardiya süresi − planlı duruşlar
Çalışma Süresi    = Planlı Süre − plansız duruşlar (stopped + offline)

Availability (A)  = Çalışma Süresi / Planlı Süre
Performance  (P)  = Σ (ideal_cycle_seconds × adet) / Çalışma Süresi      # ürün değişimlerine göre parça parça
Quality      (Q)  = İyi Adet / Toplam Adet,   İyi Adet = Toplam − Hurda
OEE               = A × P × Q
```

- **Adetler** yalnızca `counter_deltas_1m` toplamından gelir (bkz. §6.3). Hurda: `scrap_source = 'plc'` ise sayaç farkı, `manual` ise `manual_scrap_entries` toplamı.
- **İdeal çevrim süresi**, ilgili zaman diliminde makinede çalışan iş emrinin ürününe göre `product_machine_rates` tablosundan alınır. İş emri yoksa ya da eşleşme tanımlı değilse Performance "hesaplanamadı" olarak işaretlenir (sessizce 0 veya 1 yazılmaz).
- P > 1 çıkarsa (ideal süre yanlış girilmiş demektir) değer raporlanır ama uyarı gösterilir; kırpılmaz.
- Vardiya dışı zamanlar Planlı Süre'ye girmez; vardiya dışında üretim olursa ayrıca raporlanır.
- **Kayıp analizi:** Rapor ekranında A, P, Q kayıpları süre cinsinden de gösterilir (duruş kaybı, hız kaybı, kalite kaybı).
- Hesaplar `apps/api` içindeki tek bir OEE modülünde yapılır; aynı fonksiyon hem rapor endpoint'lerini hem canlı vardiya özetini besler. Birim testleri sayaç sıfırlanması, gece yarısını aşan vardiya, iş emri değişimi ve veri boşluğu senaryolarını kapsar.

---

## 10. Analitik API (`apps/api`) — Uç Noktalar (özet)

```
POST   /api/auth/login | /api/auth/refresh | /api/auth/logout
CRUD   /api/areas, /api/lines, /api/machines, /api/products, /api/shifts, /api/downtime-reasons, /api/users
GET/PUT /api/machines/{id}/plc          POST /api/machines/{id}/plc/test
GET    /api/flows/preview               POST /api/flows/deploy        GET /api/flows/deployments
CRUD   /api/production-orders           POST /api/production-orders/{id}/start|pause|complete
GET    /api/downtimes?machine_id&from&to&unassigned
PATCH  /api/downtimes/{id}              (neden atama)
POST   /api/scrap                       (manuel hurda)
GET    /api/oee?scope=plant|area|line|machine&id&from&to&group_by=hour|shift|day|week
GET    /api/reports/downtime-pareto?...   /api/reports/production?...   /api/reports/state-timeline?...
GET    /api/telemetry?machine_id&tags&from&to&resolution   (otomatik örnekleme ile)
GET    /api/reports/*.csv               (aynı raporların CSV dışa aktarımı)
```

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
- Her rapor kartının köşesinde bir **grafik türü seçici** bulunur. Seçenekler verinin yapısına göre **filtrelenir**; anlamsız kombinasyonlar sunulmaz:

| Veri | Varsayılan | Seçilebilir türler |
|---|---|---|
| Zaman içinde OEE / A / P / Q | Çizgi | Alan, sütun, birleşik (sütun + çizgi) |
| Anlık OEE özeti | Halka (A/P/Q iç içe) | Gösterge (gauge), KPI kartı |
| Makine/hat karşılaştırması | Yatay sütun (sıralı) | Gruplu sütun, yığılmış sütun (A/P/Q), tablo |
| Duruş nedenleri | Pareto (sütun + kümülatif çizgi) | Yatay sütun, ağaç harita (treemap), tablo |
| OEE kayıp dağılımı | Şelale (planlı süre → OEE süresi) | Yığılmış sütun |
| Makine × saat/gün yoğunluğu | Isı haritası | Tablo |
| Durum geçmişi | Zaman çizelgesi (gantt) | — |
| Üretim adedi | Sütun (hedef çizgisiyle) | Çizgi, kümülatif alan |
| Proses tag'leri | Çizgi | Alan, nokta |

- Seçilen grafik türü, filtreler ve zaman aralığı **URL'de** saklanır (paylaşılabilir bağlantı) ve kullanıcı tercihi olarak hatırlanır.

**Görsel dil**
- Nötr zemin, tek vurgu rengi; seri sayısı azsa renkler kategorik, çoksa gri + vurgulanan seri.
- Durum renkleri tüm uygulamada sabit: çalışıyor = yeşil, duruyor = kırmızı, planlı duruş = mavi, offline = gri. Renk tek başına bilgi taşımaz; ikon/etiketle desteklenir (renk körlüğü).
- Az ızgara çizgisi, okunaklı eksenler, doğrudan seri etiketleri (mümkünse lejant yerine), tutarlı tooltip formatı (yerel saat, birim, yüzde 1 ondalık).
- Açık/koyu tema desteği; grafik renkleri tema token'larından gelir.
- Yumuşak geçiş animasyonları (veri değişiminde), ama canlı panelde animasyon kapalı (dikkat dağıtmaması için).
- Boş veri, eksik ideal çevrim süresi ve veri boşlukları grafikte açıkça gösterilir ("veri yok" bölgesi), sıfırla doldurulmaz.

**Etkileşim**
- Üstte ortak filtre çubuğu: zaman aralığı (hazır seçenekler: bu vardiya, dün, son 7 gün, bu ay + özel), vardiya, alan/hat/makine, ürün.
- **Karşılaştırma modu:** seçili dönemi önceki dönemle üst üste göster.
- Grafikten detaya inme (drill-down): hat sütununa tıkla → hattın makineleri; pareto çubuğuna tıkla → ilgili duruş kayıtları.
- Her kartta CSV dışa aktarma ve tam ekran.

**Teknik**
- Recharts; ısı haritası, gantt ve şelale için Recharts üzerine ince özel bileşenler. Tüm grafikler ortak bir `ChartCard` sarmalayıcısı (başlık, tür seçici, durum: yükleniyor/boş/hata, dışa aktarma) içinde kullanılır.

---

## 12. Simülatör (`apps/simulator`)

- Her simüle makine için gerçek S7 protokolü konuşan bir sunucu (snap7 tabanlı) açar; böylece Node-RED akışları simülatör ve gerçek PLC için **aynıdır**.
- Konfigüre edilebilir senaryolar: normal üretim, rastgele duruşlar, mikro duruşlar, hurda oranı, **sayaç sıfırlanması**, bağlantı kopması, yavaş çalışma (Performance kaybı).
- Simüle makinelerin DB düzeni seed verisindeki `tags_json` ile birebir eşleşir.

---

## 13. Operasyon

- Compose proje adı `v-mes-2`'dir. Aynı makinedeki eski `../v-mes` projesiyle konteyner ve port çakışmasını önlemek için bu ad değiştirilmemelidir; yerel `.env` dosyasında farklı host portları kullanılır (14330, 11883, 18084, 11880).
- Günlük komutlar `Makefile` içindedir (`make up`, `make seed`, `make test`). Node.js yerelde kurulu olmasa da Node komutları Docker içinde çalışır.
- Şema değişiklikleri yalnızca yeni bir `db/migrations/V###__ad.sql` dosyasıyla yapılır. Uygulanmış bir dosya değiştirilirse migration aracı durur.
- `docker compose up` ile tüm sistem (MSSQL, EMQX, Node-RED, ingestion, api, web, simulator) ayağa kalkar. Simülatör `profiles: [dev]` altındadır.
- Her servis `/health` uç noktası sunar; compose healthcheck'leri bunlara bağlıdır.
- Loglar JSON formatında (pino / structlog); korelasyon için `machine_code` ve istek kimliği eklenir.
- Yedekleme: MSSQL için günlük tam yedek + log yedeği (üretim ortamında).

---

## 14. Geliştirme Aşamaları

| # | Aşama | Çıktı |
|---|---|---|
| 1 | Temel altyapı | Monorepo, docker-compose, DB migration'ları, `contracts` paketi |
| 2 | Veri hattı | Simülatör → Node-RED → EMQX → ingestion → MSSQL; sayaç farkları, durum makinesi, Socket.io |
| 3 | Konfigürasyon | FastAPI auth + CRUD, akış üretici, önizleme, sekme bazlı deploy; test PLC ile doğrulama |
| 4 | OEE motoru | Vardiya, ürün, iş emri, duruş, hurda; OEE ve rapor endpoint'leri + birim testleri |
| 5 | Ön yüz | Canlı panel, makine detayı, operatör ekranı, konfigüratör, raporlar |
| 6 | Sağlamlaştırma | TLS/ACL, retention/partition job'ları, uçtan uca testler, dokümantasyon |
