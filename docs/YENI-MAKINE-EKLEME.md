# Yeni Makine Ekleme — İş Akışı

Bu doküman, sisteme yeni bir makinenin (ve onun PLC'sini okuyan HUBBOX gateway'inin) nasıl ekleneceğini adım adım anlatır. Sistemin kurulumu için [KURULUM-WSL.md](KURULUM-WSL.md), genel bilgi için [README](../README.md).

```
PLC (S7) ──102──► HUBBOX (Node-RED) ──MQTT 1883──► Sunucu (V-MES)
                        ▲
                        └──── HTTP 1880 (akış dağıtımı) ──── V-MES
```

Her makinenin PLC'si, o makinedeki HUBBOX içinde çalışan Node-RED tarafından okunur. V-MES, okuma akışlarını her HUBBOX'a **ayrı ayrı** dağıtır; HUBBOX'taki diğer (MES dışı) akışlara dokunmaz.

---

## Özet

| # | Adım | Kim | Nerede | Süre |
|---|---|---|---|---|
| 1 | PLC hazırlığı | Otomasyon | TIA Portal | değişir |
| 2 | HUBBOX hazırlığı | Otomasyon / saha | HUBBOX | ~30 dk |
| 3 | Ağ erişimi | IT | Güvenlik duvarı | — |
| 4 | Sinyalleri belirleme | Mühendis + üretim | — | ~15 dk |
| 5 | HUBBOX'ı ekleme ve kontrol | Mühendis | **Edge cihazları** | 2 dk |
| 6 | Makineyi tanımlama | Mühendis | **PLC konfigüratörü** | 5 dk |
| 7 | Tag'leri içe aktarma | Mühendis | **PLC konfigüratörü** | 5 dk |
| 8 | Dağıtım | Mühendis | **PLC konfigüratörü** | 1 dk |
| 9 | Doğrulama | Mühendis | **Canlı panel**, **Edge cihazları** | 5 dk |
| 10 | Ürün ve çevrim süreleri | Mühendis | **Tanımlar** | 5 dk |
| 11 | Kullanıma alma | Üretim | **Operatör ekranı** | — |

Altyapı kurulduktan ve HUBBOX hazırsa 5–10. adımlar toplam 15–20 dakika sürer.

---

## 1. PLC hazırlığı (TIA Portal)

- [ ] **PUT/GET erişimi açık:** CPU özellikleri → *Protection & Security* → *Connection mechanisms* → **"Permit access with PUT/GET communication from remote partner"**.
- [ ] **Okunacak DB optimize edilmemiş:** DB özellikleri → *Attributes* → **"Optimized block access" kapalı**. DB editöründe **"Offset" sütunu görünüyorsa** DB optimize edilmemiştir.
- [ ] **Sayaçlar uygun tipte:** üretim/hurda sayaçları **DInt, UDInt, DWord, Word veya UInt** olmalı. Int (işaretli 16 bit) taşınca negatife düşer ve sıfırlanmadan ayırt edilemez. 16 bit sayaçların 65.535 → 0 taşması sistemde kayıpsız hesaplanır.

> **Mevcut DB optimize edilmişse:** mevcut bloklara dokunmadan, yalnızca MES'in okuyacağı optimize edilmemiş ayrı bir DB (ör. `DB100 "MES_Interface"`) oluşturulup ilgili değerler PLC programında buraya kopyalanabilir. PLC'ye yükleme gerektirir; otomasyon ekibiyle planlayın.

**Dışa aktarma:** İçe aktarma için DB'nin ad / veri tipi / ofset bilgisini içeren bir tablo hazırlayın: DB'yi Excel'e aktarın **veya** DB editöründe satırları seçip kopyalayın (7. adımda yapıştırılabilir).

## 2. HUBBOX hazırlığı

- [ ] HUBBOX kurumsal ağa bağlı ve sabit IP'li (ör. `10.146.168.19`).
- [ ] HUBBOX içinde Docker üzerinde **Node-RED** çalışıyor (3.x / 4.x / 5.x).
- [ ] Node-RED'de **`node-red-contrib-s7` (3.x)** yüklü (☰ → *Manage palette* → *Installed*).
- [ ] Node-RED editörü/Admin API'si **kullanıcı adı ve şifreyle korunuyor**. Bilgiler tüm HUBBOX'larda aynı ve sunucunun `.env` dosyasındaki `EDGE_NODERED_USER` / `EDGE_NODERED_PASSWORD` ile eşleşiyor. Varsayılan şifreler değiştirilmeli.
- [ ] HUBBOX saati **NTP ile senkron** (zaman damgaları HUBBOX'ta atanır). Sistem kaymayı ölçer; 30 saniyeyi aşarsa uyarı verir.
- [ ] HUBBOX'ın makine ağı tarafında PLC'ye erişim var (mevcut Node-RED akışlarıyla doğrulanabilir).
- [ ] Güvenlik: HUBBOX güvenlik duvarında PLC'nin 102 portu yalnızca HUBBOX'ın kendisine açık.

## 3. Ağ erişimi (IT)

| Yön | Port | Amaç |
|---|---|---|
| Sunucu → HUBBOX | TCP 1880 | Akış dağıtımı ve kontrol (Node-RED Admin API) |
| HUBBOX → Sunucu | TCP 1883 (TLS: 8883) | Telemetri (MQTT) |

## 4. Sinyalleri belirleme

Makine için hangi PLC sinyallerinin ne anlama geldiğini üretimle birlikte netleştirin:

| Soru | Sistemdeki karşılığı |
|---|---|
| Makineden çıkan **biten ürün** adedi hangi sayaçta? | `total_count` rolü (zorunlu) |
| Ayrı bir **hurda / NOK** sayacı var mı? | Varsa `scrap_count` rolü; yoksa hurdayı operatör girer (*Hurda kaynağı: operatör*) |
| Makinenin **çalıştığını** hangi sinyal gösteriyor? | `running` (bit) veya `state_code` (1 = çalışıyor); yoksa *sayaç hareketinden* (eşik süresiyle) |
| İzlenmek istenen **proses değerleri** (sıcaklık, basınç, sensörler…) | `process` rolü |
| Bir parçanın **ideal çevrim süresi** (ürün/model başına) | **Tanımlar → Ürünler** (10. adım) |

> **Seri istasyonlu makineler** (parça istasyonlardan sırayla geçiyor): makine **tek makine** olarak tanımlanır; üretim adedi **son istasyonun** sayacından alınır. İstasyonları ayrı makine yapmak aynı parçayı her istasyonda yeniden sayar ve hat/fabrika toplamlarını şişirir. Diğer istasyonların sinyalleri darboğaz analizi için proses değeri olarak izlenebilir.

## 5. HUBBOX'ı ekleme ve kontrol

**Edge cihazları → Edge ekle**

| Alan | Örnek | Not |
|---|---|---|
| Kod | `hubbox-mekanik` | küçük harf, rakam, tire; **sonradan değiştirilemez** (MQTT topic'inde ve Node-RED sekme kimliklerinde kullanılır) |
| Ad | Mekanik HUBBOX | |
| Node-RED adresi | `http://10.146.168.19:1880` | sunucudan erişilebilen adres |

Ardından **Kontrol**: tüm maddeler ✓ olmalı (erişim, kimlik doğrulama, Node-RED ve `node-red-contrib-s7` sürümü, MQTT adresi). Kontrol hiçbir şeyi değiştirmez; HUBBOX'taki mevcut sekmeleri ve S7 bağlantılarını listeler.

## 6. Makineyi tanımlama

**PLC konfigüratörü** → (gerekirse alan ve hat ekleyin) → hattın yanındaki **+** → makine:

| Alan | Açıklama |
|---|---|
| Makine kodu | ör. `mekanik-01`; **sonradan değiştirilemez** |
| Ad | ekranlarda görünen ad |
| Çalışma durumu kaynağı | *PLC durum tag'i* (bit/durum kodu varsa) veya *sayaç hareketinden* |
| Hareketsizlik eşiği | sayaç modunda: sayaç bu süre artmazsa "duruyor". **İdeal çevrim süresinin en az 2–3 katı** olmalı (ör. 19 sn çevrimde 60 sn) |
| Hurda kaynağı | *PLC hurda sayacı* veya *operatör girişi* |
| Edge | 5. adımda eklenen HUBBOX |
| PLC adresi | HUBBOX'ın makine ağındaki adres (ör. `192.168.10.1`); her HUBBOX'ın kendi izole ağı olduğundan aynı adres tekrar edebilir |
| Port / rack / slot | 102 / 0 / 1 (S7-1200/1500); S7-300: slot 2 |
| Okuma periyodu | 1000 ms genelde yeterli; hızlı sayaçlarda 500 ms |

## 7. Tag'leri içe aktarma

**Tag'ler → TIA'dan içe aktar**

1. **Excel / CSV dosyası** seçin veya **DB editöründen yapıştır** ile kopyaladığınız satırları yapıştırın. DB numarası dosyada yoksa elle girin.
2. **Satırları oku**: sütunlar içeriğe göre tanınır (ad, veri tipi, `892.1` biçiminde ofset). Struct/dizi elemanları ad öneki olur (`MakinaIstasyonData[2].kosuBiti` → `DB200,X902.2`).
3. Okunmayan satırlar nedeniyle gösterilir (String, LReal, 64 bit, Time/DTL…). Tipi boş bırakılmış bit satırları Bool varsayılır ve **"doğrulayın"** notuyla işaretlenir.
4. Almak istediğiniz satırları seçin; gerekirse **tag adını** kısaltın (ör. `ist7_sayac`), **rol** ve **birim** atayın. *Sayaç adayı*, *çalışıyor adayı* etiketleri yalnızca öneridir.
   - Toplam sayaç, hurda sayacı, çalışıyor bit'i ve durum kodu rolleri **yalnızca bir** tag'e atanabilir.
5. **Aktar** → tag tablosuna eklenir; doğrulama anında çalışır (adres sözdizimi, rol–tip uyumu, zorunlu roller, aynı belleği okuyan tag uyarıları).
6. **Kaydet**.

**Aynı tip makine** (aynı PLC programı): **Başka makineden kopyala** ile tag listesi ve bağlantı ayarları kopyalanır; yalnızca edge ve PLC adresi değiştirilir.

## 8. Dağıtım

**Node-RED dağıtımı** kartı her edge için durumu gösterir (+ yeni sekme, ~ değişen, − kaldırılacak). İlgili HUBBOX'ın satırında **Dağıt** (veya **Tümünü dağıt**). Yalnızca değişen sekmeler yeniden başlatılır; diğer makinelerin okuması kesilmez. Erişilemeyen bir HUBBOX diğerlerinin dağıtımını engellemez. Geçmiş: **Geçmiş** düğmesi.

## 9. Doğrulama

- [ ] **Edge cihazları:** HUBBOX **Çevrimiçi**, saat **senkron**.
- [ ] **Canlı panel:** makine kartı birkaç saniye içinde *Çalışıyor* / *Duruyor* durumuna geçiyor.
- [ ] **Makine detayı:** tag değerleri her okumada güncelleniyor; sayaç makine çalışırken artıyor.
- [ ] Makineyi kısa süre durdurun (veya durmasını bekleyin): durum *Duruyor*'a geçiyor; 60 sn'yi aşan duruş, **Operatör ekranı**nda "nedeni girilmemiş duruş" olarak görünüyor.
- [ ] PLC'deki sayaç değeri ile ekrandaki değer aynı.

**Sorun olursa**

| Belirti | Bakılacak yer |
|---|---|
| Makine "Bağlantı yok", HUBBOX çevrimiçi | PLC erişimi: IP/rack/slot, PUT/GET; HUBBOX Node-RED'de MES sekmesindeki S7 düğümünün durumu |
| HUBBOX "Erişilemiyor" | HUBBOX → sunucu 1883 erişimi; `FLOW_MQTT_HOST` |
| Değerler anlamsız | Optimize DB (ofsetler kayar) veya yanlış veri tipi; TIA'daki ofsetlerle karşılaştırın |
| "Edge saati kaymış" uyarısı | HUBBOX NTP ayarı |

## 10. Ürün ve çevrim süreleri

**Tanımlar → Ürünler:** makinenin ürettiği her ürün/model için **bu makinedeki ideal çevrim süresini** (saniye) girin. Performans ve OEE bu olmadan hesaplanmaz. Gerekirse **Vardiyalar** ve **Duruş nedenleri** de güncellenir.

## 11. Kullanıma alma

- Operatörler **Operatör ekranı**nda makineyi seçer (tablet bunu hatırlar), iş emrini başlatır, duruşlara neden girer, hurda girer.
- **İş emri olmadan yapılan üretimde performans ve OEE hesaplanmaz** (ideal hız bilinmez); ekranlar bunu belirtir.

---

## Örnek: Mekanik makinesi (ilk saha makinesi)

| Konu | Karar / bilgi | Durum |
|---|---|---|
| PLC | S7-1500, `192.168.10.1`, port 102, rack/slot 0/1 | ✓ |
| Edge | HUBBOX `10.146.168.19:1880`, Node-RED 4.1.3, `node-red-contrib-s7` | ✓ (kontrol kurumsal ağdan yapılacak) |
| DB | `DB200`, optimize edilmemiş | ✓ |
| Yapı | 7 istasyon, parça istasyonlardan **sırayla** geçer → **tek makine** | ✓ |
| Üretim adedi | 7. istasyonun `sonsuzSayici` (UInt) → `DB200,WORD956` (örüntüye göre; tam DB tablosuyla doğrulanacak) | adres doğrulanacak |
| Çalışma durumu | Aday: 7. istasyonun `kosuBiti` (`DB200,X952.2`), herhangi bir istasyonun koşu biti veya sayaç hareketi | **karar bekliyor** |
| Hurda | Ayrı sayaç yok → **operatör girişi** | ✓ |
| İdeal çevrim süresi | Ortalama **19 sn** (modele göre değişebilir) | ✓ |
| `MODEL_ADI` (String, ofset 16.0) | Aktif modeli gösterir. İleride ürünün otomatik belirlenmesi için kullanılabilir (String okuma + model ↔ ürün eşleştirmesi gerekir) | sonraki adım |
| Diğer istasyon sinyalleri | Giriş/çıkış sensörleri, koşu bitleri, sayaçlar — darboğaz analizi için proses değeri olarak izlenebilir | isteğe bağlı |

DB200 adres örüntüsü (her istasyon 10 bayt, 1. istasyon 892.0'dan başlar): `n`. istasyon için başlangıç = `892 + (n−1) × 10`; giriş sensörü `.0`, çıkış sensörü `.1`, koşu biti `.2`, sayaç `+4` (UInt).

| İstasyon | Giriş | Çıkış | Koşu biti | Sayaç |
|---|---|---|---|---|
| 1 | X892.0 | X892.1 | X892.2 | WORD896 |
| 2 | X902.0 | X902.1 | X902.2 | WORD906 |
| 3 | X912.0 | X912.1 | X912.2 | WORD916 |
| 4 | X922.0 | X922.1 | X922.2 | WORD926 |
| 5 | X932.0 | X932.1 | X932.2 | WORD936 |
| 6 | X942.0 | X942.1 | X942.2 | WORD946 |
| 7 | X952.0 | X952.1 | X952.2 | WORD956 |

(4–7. istasyonlar örüntüden hesaplanmıştır; tam DB tablosuyla doğrulanmalıdır.)
