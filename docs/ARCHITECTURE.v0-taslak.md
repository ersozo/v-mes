# IIoT & OEE Manufacturing Execution System (MES) - Mimari Kurallar (MS SQL Server Edition)

## 1. Sistem Özeti ve Teknoloji Yığını (Tech Stack)
Bu proje uçtan uca bir Endüstriyel IoT veri toplama, canlı izleme ve OEE (Overall Equipment Effectiveness) raporlama monorepo projesidir.
- **Altyapı:** Docker & Docker Compose
- **Edge & Saha Ağ Katmanı :** Sahadaki PLC'ler **HUBBOX Connect X2** Industrial IoT Router arkasındadır. Node-RED, HUBBOX üzerinden sağlanan güvenli ağ/tünel rotasından PLC'leri (Modbus TCP, S7, OPC UA) sorgular (polling), veriyi normalize eder ve EMQX MQTT Broker'a basar. B
- **MQTT Broker:** EMQX . UNS topic yapısı, wildcard aboneliği)
- **Ingestion & Real-Time :** Node.js (TypeScript), `mqtt`, `zod` (validasyon), `mssql` (Native Bulk Insert API), `socket.io` (Canlı WebSocket yayını).
- **Veritabanı (`/db`):** MS SQL Server 2022 . Veritabanı adı: `MES_DB`. Hem ilişkisel tablolar (`machines`, `machine_plc_configs`, `shifts`, `production_orders`, `downtime_logs`) hem de zaman serisi tablosu (`machine_telemetry`) aynı veritabanındadır. Zaman serisi tablosu yüksek sıkıştırma ve analitik hız için `CLUSTERED COLUMNSTORE INDEX` kullanır.
- **Analitik & Raporlama API :** Python 3.11+, FastAPI, `pymssql` (ODBC sürücü karmaşasını önlemek için doğrudan TDS protokolü ile), Pydantic v2. Node-RED akışlarını üreten motoru barındırır.
- **Ön Yüz :** React (Vite + TypeScript), TailwindCSS, Recharts, Socket.io-client, Lucide-React. Canlı izleme paneli ve Zero-Code PLC konfigüratörü içerir.
- **Simülatör :** Sahadaki PLC'leri taklit eden Node.js / TypeScript test scripti.

## 2. UNS (Unified Namespace) ve ISA-95 Topic Standardı
Endüstriyel 4.0 ve UNS prensiplerine uygun olarak telemetri topic hiyerarşisi ISA-95 standart modelini takip eder:

```
factory / {area_slug} / {line_slug} / {machine_id} / telemetry
```

Ingestion servisi broker'a  topic kalıbıyla abone olarak yeni eklenen tüm alan ve hatları dinamik olarak dinler.

---

## 3. Edge Katmanı Cihaz Kaydı & Konfigürasyon Mimarisi (Device Registration)

### 3.1. Veri Modeli (`dbo.machine_plc_configs`)
Sistemde her makinenin fiziksel PLC bağlantı ve DB adres bilgileri db tablosunda saklanır:
- **Hiyerarşi:** UNS ile tanimlana yapıyla uyumlu.
- **Veri Blokları (TIA Portal DB Adresleri):**
- **Dinamik Tag Listesi (`tags_json`):** Kullanıcı tanımlı tag'ler (isim, adres, rol, birim). örnek: `db_total_count` (Örn: `DB1,DINT2`)


### 3.2. Cihaz Kayıt (Onboarding) ve Dağıtım İş Akışı
1. **Kayıt / Güncelleme:** Web arayüzü veya REST API üzerinden makine parametreleri girilir.
2. **Akış Üretimi :** Kayıtlı tüm aktif makineler taranarak Node-RED uyumlu flow JSON'ı dinamik olarak oluşturulur.
   - Her makine için `s7-endpoint`, `s7-in`, normalizasyon `function` ve ortak `mqtt out` düğümleri bağlanır.
   - HUBBOX Watchdog mekanizması ve heartbeat inject düğümü otomatik entegre edilir.
3. **Sıfır Kesintiyle Dağıtım (Zero-Downtime Hot-Reload):**
   - Üretilen akış Node-RED Admin REST API'sine HTTP üzerinden iletilir.
   - Node-RED konteyneri yeniden başlatılmadan akış bellekte canlı güncellenir.
   - Aynı zamanda kalıcılık için bir dosyaya yazılır.
4. **Önizleme:**  uç noktası üzerinden deploy öncesi akış JSON yapısı incelenebilir.


## 4. HUBBOX Connect X2 & Watchdog Güvenlik Kuralları
- Sahadaki PLC'ler izole makine ağında (192.168.10.x) yer alır ve dışarıya kapalıdır.


## 5. Diferansiyel OEE Hesaplama İlkeleri
- PLC sayaçları sürekli artan kümülatif sayaçlardır.
- Seçilen zaman penceresinde üretilen miktar hesaplanırken `SUM()` kesinlikle kullanılmaz:
  $$\Delta = \max(\text{count}) - \min(\text{count})$$
- OEE = (Availability $\times$ Performance $\times$ Quality) / 10000.
