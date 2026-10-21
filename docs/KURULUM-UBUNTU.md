# V-MES Kurulum Rehberi — Ubuntu Server sanal makine

Bu rehber V-MES'i kurumsal ağdaki bir **Ubuntu Server sanal makinede Docker ile** 7/24 çalışacak şekilde kurar. Genel bilgi ve komutlar için [README](../README.md), mimari için [ARCHITECTURE](../ARCHITECTURE.md), ilk makineyi tanımlamak için [YENI-MAKINE-EKLEME](YENI-MAKINE-EKLEME.md).

> Windows sanal makine üzerinde WSL2 ile kurulum gerekiyorsa: [KURULUM-WSL.md](KURULUM-WSL.md) (iç içe sanallaştırma gerektirir).

---

## İçindekiler

0. [Hazırlık: bilgi ve izin listesi](#0-hazırlık-bilgi-ve-izin-listesi)
1. [Sanal makine gereksinimleri](#1-sanal-makine-gereksinimleri)
2. [Ubuntu ilk ayarlar](#2-ubuntu-ilk-ayarlar)
3. [Docker Engine kurulumu](#3-docker-engine-kurulumu)
4. [Güvenlik duvarı](#4-güvenlik-duvarı)
5. [V-MES kurulumu](#5-v-mes-kurulumu)
6. [HUBBOX bağlantısı ve ilk makine](#6-hubbox-bağlantısı-ve-ilk-makine)
7. [Yedekleme](#7-yedekleme)
8. [Güncellemeler ve yeniden başlatma](#8-güncellemeler-ve-yeniden-başlatma)
9. [Kabul testi (kontrol listesi)](#9-kabul-testi)
10. [Sorun giderme](#10-sorun-giderme)

---

## 0. Hazırlık: bilgi ve izin listesi

Kuruluma başlamadan IT ile şunları netleştirin:

| # | Konu | Ayrıntı |
|---|---|---|
| 1 | Sanal makine | Ubuntu Server 24.04 LTS (bkz. §1) |
| 2 | Sabit IP | Sanal makinenin kurumsal ağdaki IP'si sabit olmalı (HUBBOX'lar MQTT'yi bu adrese gönderir). Bir DNS adı da (ör. `mes.fabrika.local`) önerilir |
| 3 | Gelen erişim → sanal makine | **TCP 443** ve 80 (arayüz; kullanıcılar/tabletler; 80 yalnızca 443'e yönlendirir), **TCP 8883** (HUBBOX'lardan MQTT, TLS), **TCP 22** (SSH; yalnızca yönetici ağından) |
| 4 | Giden erişim sanal makine → HUBBOX'lar | **TCP 1880** (Node-RED Admin API; akış dağıtımı) — her HUBBOX için |
| 5 | Kurulum sırasında internet | Docker imajları ve Ubuntu paketleri için (proxy varsa adresi) |
| 6 | Saat | Sanal makine ve **tüm HUBBOX'lar** kurumsal NTP sunucusuna senkron (NTP sunucusunun adresi) |
| 7 | Sertifika | `mes.fabrika.local` (ve/veya IP) için kurumsal CA'dan sunucu sertifikası; yoksa kendinden imzalı (bkz. §5.3) |
| 8 | Yedek hedefi | Günlük veritabanı yedeklerinin kopyalanacağı ağ paylaşımı (adres ve servis hesabı) |

> **MQTT yalnızca TLS (8883) ile.** Üretim katmanı (`docker-compose.prod.yml`) broker'ın şifresiz 1883 portunu dışarı açmaz; HUBBOX'lar 8883'e TLS ile bağlanır ve her HUBBOX'ta CA sertifikası bulunur (bkz. §6.1).

## 1. Sanal makine gereksinimleri

| Kaynak | Öneri | Not |
|---|---|---|
| vCPU | 4 | |
| RAM | 12 GB (16 GB rahat) | MS SQL ~2–4 GB; diğer servisler toplam ~2 GB |
| Disk | 150 GB SSD | Telemetri saklama süresine göre (varsayılan 180 gün) + yedekler |
| İşletim sistemi | Ubuntu Server 24.04 LTS | Masaüstü arayüzü gerekmez; kurulumda **OpenSSH server** seçilsin |

İç içe sanallaştırma **gerekmez**.

## 2. Ubuntu ilk ayarlar

SSH ile bağlanın (`ssh <kullanıcı>@<sunucu-ip>`). Tüm komutlar sunucuda.

### 2.1 Paketler

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl git make cifs-utils
```

### 2.2 Disk: tüm alanı kullanın

Ubuntu Server kurulumu LVM ile varsayılan olarak diskin **yalnızca bir kısmını** (çoğunlukla 100 GB'a kadar) kök bölüme ayırır. Kontrol edip genişletin:

```bash
df -h /                       # kök bölümün boyutu
sudo vgs                      # "VFree" boş alan gösteriyorsa:
sudo lvextend -r -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
df -h /                       # artık diskin tamamı
```

### 2.3 Saat dilimi ve NTP

```bash
sudo timedatectl set-timezone Europe/Istanbul
sudo sed -i 's/^#\?NTP=.*/NTP=ntp.fabrika.local/' /etc/systemd/timesyncd.conf   # kurumsal NTP sunucusu
sudo systemctl restart systemd-timesyncd
timedatectl                   # "System clock synchronized: yes" görülmeli
```

Uygulama içi tüm zamanlar UTC tutulur; saat dilimi yalnızca log okumayı kolaylaştırır. Saatin **senkron** olması ise önemlidir: HUBBOX'larla aradaki kayma arayüzde uyarı olarak görünür.

## 3. Docker Engine kurulumu

[Docker'ın resmi talimatları](https://docs.docker.com/engine/install/ubuntu/) ile (Ubuntu'nun kendi `docker.io` paketi değil; Compose sürümü eski kalır):

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo systemctl enable --now docker containerd
sudo usermod -aG docker $USER          # oturumu kapatıp yeniden SSH ile bağlanın
docker run --rm hello-world
docker compose version                 # v2.24+ olmalı
```

Docker systemd servisi olarak açılışta kendiliğinden başlar; V-MES konteynerleri `restart: unless-stopped` ile onunla birlikte ayağa kalkar. Ayrıca bir otomatik başlatma ayarı gerekmez.

**Kurumsal proxy varsa** Docker'ın imaj çekebilmesi için (apt için de `/etc/apt/apt.conf.d/95proxy` gerekebilir):

```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/proxy.conf >/dev/null <<'EOF'
[Service]
Environment="HTTP_PROXY=http://proxy.fabrika.local:8080"
Environment="HTTPS_PROXY=http://proxy.fabrika.local:8080"
Environment="NO_PROXY=localhost,127.0.0.1,10.0.0.0/8,.fabrika.local"
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
```

## 4. Güvenlik duvarı

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 10.146.0.0/16 to any port 22 proto tcp   # SSH: yalnızca yönetici ağı (kendi ağınıza göre)
sudo ufw allow 80,443/tcp                                    # arayüz
sudo ufw allow 8883/tcp                                      # HUBBOX → MQTT (TLS)
sudo ufw enable                                              # SSH kuralını eklemeden açmayın!
sudo ufw status verbose
```

> **Önemli — Docker `ufw`'yu atlar.** Docker'ın dışarı açtığı (publish edilen) portlar `ufw` kurallarından bağımsız olarak erişilebilir olur. V-MES'in üretim katmanı bu yüzden hassas portları zaten yalnızca sunucunun kendisine bağlar: MS SQL (1433), Node-RED editörü (1880) ve EMQX paneli (18083) `127.0.0.1`'de dinler; API ve ingestion hiç dışarı açılmaz. Yukarıdaki `ufw` kuralları SSH'yi ve sunucunun kendi servislerini korur. **`docker-compose.prod.yml`'deki `127.0.0.1:` öneklerini kaldırmayın**; kabul testinde (§9) bu portlara başka bir bilgisayardan erişilemediğini doğrulayın.

Bu sunuculara yönetimsel erişim gerektiğinde SSH tüneli kullanın:

```bash
ssh -L 18083:127.0.0.1:18083 -L 1880:127.0.0.1:1880 <kullanıcı>@<sunucu-ip>
# ardından kendi bilgisayarınızda http://localhost:18083 (EMQX paneli)
```

## 5. V-MES kurulumu

### 5.1 Kodu alın

```bash
sudo mkdir -p /opt/v-mes && sudo chown $USER: /opt/v-mes
git clone <DEPO-ADRESİ> /opt/v-mes
cd /opt/v-mes
```

### 5.2 Ortam dosyası

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Doldurulacaklar:

| Ayar | Değer |
|---|---|
| Tüm `*_PASSWORD`, `NODERED_CREDENTIAL_SECRET` | Güçlü, benzersiz değerler (`openssl rand -base64 24`) |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `COMPOSE_PROFILES=dev` | **Silin** (simülatör üretimde çalışmaz) |
| `MSSQL_PID` | Lisansınız: `Express` (10 GB sınırı), `Standard`, `Enterprise` (`Developer` üretimde kullanılamaz) |
| `CORS_ORIGIN` | Arayüzün adresi, ör. `https://mes.fabrika.local` |
| Portlar | Varsayılanlar kalabilir; üretim katmanı iç portları dışarı açmaz |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | İlk yönetici; ilk girişten sonra arayüzden kişisel hesaplar açıp bunu kaldırabilirsiniz |
| `FLOW_MQTT_TLS`, `EDGE_*`, `FLOW_MQTT_*` | §6.1'de |

### 5.3 Sertifikalar

Kurumsal CA'dan alınan dosyaları kendi bilgisayarınızdan kopyalayın:

```bash
# kendi bilgisayarınızda
scp server.crt server.key ca.crt <kullanıcı>@<sunucu-ip>:/opt/v-mes/infra/certs/
# sunucuda
chmod 640 /opt/v-mes/infra/certs/server.key
```

`server.crt`'nin SAN alanı hem kullanıcıların (`mes.fabrika.local`) hem de **HUBBOX'ların bağlandığı ad/IP'yi** (`FLOW_MQTT_HOST`) içermelidir; aynı sertifika EMQX'te (8883) de kullanılır.

Kurumsal sertifika henüz yoksa geçici olarak kendinden imzalı (sunucunun adı ve IP'si ile):

```bash
scripts/gen-certs.sh mes.fabrika.local 10.146.x.x
```

Bu durumda `infra/certs/ca.crt` dosyasını kullanıcıların tarayıcılarına/tabletlerine güvenilir kök sertifika olarak yükleyin.

### 5.4 Başlatma

Önce yedek klasörünü MSSQL konteynerinin kullanıcısına (uid 10001) verin. Klasör yoksa Docker onu `root` sahipliğinde oluşturur ve veritabanı yedeği "Access is denied" hatasıyla başarısız olur:

```bash
mkdir -p backups && sudo chown 10001:10001 backups
```

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose run --rm db-migrate
docker compose ps        # tüm servisler "healthy"
```

İlk derleme internet hızına göre 5–15 dakika sürer. Tarayıcıdan `https://mes.fabrika.local` (veya IP) ile giriş yapın.

> Üretim kurulumunda örnek veri (`make seed`) **yüklemeyin**; alan/hat/makine, ürün, vardiya ve duruş nedenlerini arayüzden tanımlayın. Duruş nedenleri için `db/seed/001_dev_seed.sql` içindeki listeyi başlangıç noktası olarak kullanabilirsiniz.

Kolaylık için kısa yol (`~/.bashrc` sonuna):

```bash
alias mes='docker compose -f /opt/v-mes/docker-compose.yml -f /opt/v-mes/docker-compose.prod.yml --project-directory /opt/v-mes'
# kullanım: mes ps, mes logs -f ingestion, mes restart api
```

## 6. HUBBOX bağlantısı ve ilk makine

### 6.1 Ayarlar (tüm HUBBOX'lar için ortak)

**Her HUBBOX'a CA sertifikası:** Node-RED broker sertifikasını `ca.crt` ile doğrular. `infra/certs/ca.crt` dosyasını her HUBBOX'ta Node-RED'in okuyabildiği bir yola koyun (Node-RED konteynerde çalışıyorsa veri klasörü altında, ör. `/data/certs/ca.crt`). Yol tüm HUBBOX'larda aynı olmalıdır.

`.env` içinde:

```ini
FLOW_MQTT_TLS=true
EDGE_NODERED_USER=<HUBBOX Node-RED kullanıcısı>
EDGE_NODERED_PASSWORD=<HUBBOX Node-RED şifresi>
FLOW_MQTT_MODE=inline
FLOW_MQTT_HOST=<sunucunun kurumsal IP'si veya DNS adı; sertifikanın SAN'ında olmalı>
FLOW_MQTT_USER=<MQTT_NODERED_USER ile aynı>
FLOW_MQTT_PASSWORD=<MQTT_NODERED_PASSWORD ile aynı>
FLOW_MQTT_CA_FILE=/data/certs/ca.crt     # HUBBOX ÜZERİNDEKİ yol
```

```bash
mes up -d api            # yeni ayarlarla API'yi yeniden oluştur
```

### 6.2 HUBBOX'ı ekleyin

Arayüzde **Edge cihazları → Edge ekle**: kod (ör. `hubbox-mekanik`), ad, Node-RED adresi (`http://10.146.168.19:1880`). Ardından **Kontrol**: tüm maddeler ✓ olmalı ve son satır "Akışlar MQTT'ye `<FLOW_MQTT_HOST>:8883` adresinden bağlanacak (mod: inline, TLS: açık)" olmalı.

HUBBOX'tan sunucunun MQTT portuna erişimi ayrıca doğrulamak için HUBBOX'taki Node-RED'de geçici bir `mqtt out` düğümüyle `FLOW_MQTT_HOST:8883` adresine TLS (aynı CA dosyası) ile bağlanmayı deneyebilirsiniz (bağlandı → yeşil). Sonra düğümü silin.

### 6.3 İlk makine

Ayrıntılı iş akışı: [YENI-MAKINE-EKLEME.md](YENI-MAKINE-EKLEME.md). Özetle **PLC konfigüratörü**nde:

1. Alan → hat → makine ekleyin; **edge** olarak HUBBOX'ı seçin.
2. PLC: `192.168.10.1`, port 102, rack/slot `0/1` (S7-1500).
3. Tag'ler: **TIA'dan içe aktar** → DB tablosunu (.xlsx) seçin → satırları seçip rolleri atayın (toplam sayaç, çalışıyor bit'i, istasyon koşu bitleri…).
4. **Node-RED dağıtımı** kartında HUBBOX için farkı gözden geçirip **Dağıt**.
5. Canlı panelde makinenin "Çalışıyor/Duruyor" durumuna geçtiğini ve tag değerlerinin aktığını doğrulayın; **Edge cihazları**nda HUBBOX "Çevrimiçi" ve saati "senkron" olmalı.

## 7. Yedekleme

Ağ paylaşımını bağlayın (`/etc/fstab`; `cifs-utils` §2.1'de kuruldu):

```bash
sudo mkdir -p /mnt/mes-yedek
sudo tee /root/.smbcred >/dev/null <<'EOF'
username=<servis-hesabı>
password=<şifre>
domain=<ALAN>
EOF
sudo chmod 600 /root/.smbcred
echo "//dosya-sunucusu/mes-yedek  /mnt/mes-yedek  cifs  credentials=/root/.smbcred,uid=$(id -u),gid=$(id -g),_netdev,nofail  0  0" | sudo tee -a /etc/fstab
sudo mount -a && ls /mnt/mes-yedek
```

Günlük yedek ve paylaşıma kopya. Yedek dosyaları MSSQL kullanıcısına (uid 10001) ait olduğu için görev **root** crontab'ında çalışır (`sudo crontab -e`):

```cron
# Her gece 03:00 yedek al, ağ paylaşımına kopyala
0 3 * * * cd /opt/v-mes && ./scripts/backup.sh >> /var/log/vmes-backup.log 2>&1 && cp -n backups/*.bak /mnt/mes-yedek/ 2>> /var/log/vmes-backup.log
```

Elle denemek için: `sudo ./scripts/backup.sh` (§5.4'teki klasör sahipliği yapılmış olmalı).

`backup.sh` yedeği doğrular ve `BACKUP_KEEP_DAYS`'ten (varsayılan 14) eski yerel yedekleri siler; paylaşımdaki kopyaların saklama süresini dosya sunucusu tarafında belirleyin.

Geri yükleme: README → "Yedekleme ve geri yükleme". **Geri yüklemeyi kurulumdan sonra bir kez deneyin** (bkz. §9).

## 8. Güncellemeler ve yeniden başlatma

**Ubuntu güvenlik güncellemeleri** `unattended-upgrades` ile kendiliğinden kurulur. Çekirdek güncellemesi gibi yeniden başlatma gerektirenler için bakım saatinde otomatik yeniden başlatmayı açın (veya IT'nin yama takvimine bırakın):

```bash
sudo tee /etc/apt/apt.conf.d/52vmes-reboot >/dev/null <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:30";
EOF
```

Yeniden başlatma sırasında edge'ler MQTT'ye bağlanamaz; Node-RED yeniden bağlanır, kesinti süresi raporlarda "veri yok" olarak görünür (OEE'ye katılmaz). Gece yarısı vardiyası varsa saati vardiya düzenine göre seçin. Docker paketleri de bu yolla güncellenebilir; güncelleme sırasında konteynerler kısa süre yeniden başlar.

**V-MES güncellemesi:**

```bash
cd /opt/v-mes
git pull
mes up -d --build
mes run --rm db-migrate
```

## 9. Kabul testi

Kurulumu teslim almadan önce:

- [ ] `mes ps` → tüm servisler `healthy`
- [ ] Kurumsal ağdaki başka bir bilgisayardan `https://<adres>` açılıyor, sertifika uyarısı yok
- [ ] `http://<adres>` → HTTPS'e yönlendiriyor
- [ ] Başka bir bilgisayardan 1433 (SQL), 1880 (Node-RED), 18083 (EMQX paneli), 1883 (şifresiz MQTT), 8000/3001 (API/ingestion) portlarına **erişilemiyor** (ör. `nc -zv <adres> 1433` → başarısız)
- [ ] Edge cihazları → **Kontrol** → tüm maddeler ✓, MQTT `:8883`, TLS açık
- [ ] İlk makine canlı panelde görünüyor; arayüzün sol alt köşesinde "Canlı" (saat kayması uyarısı yok)
- [ ] **Yeniden başlatma testi:** `sudo reboot`, **SSH ile bağlanmadan** 5 dakika bekleyin, başka bir bilgisayardan arayüzü açın → veri akıyor
- [ ] **HUBBOX kesintisi:** HUBBOX'ın ağ kablosunu 2 dk çıkarın → makine "Bağlantı yok", edge uyarısı; takınca kendiliğinden düzeliyor
- [ ] `sudo ./scripts/backup.sh` çalışıyor, dosya ağ paylaşımına kopyalanıyor
- [ ] Bir test veritabanına geri yükleme denendi (`DB=MES_RESTORE_TEST` ile önce yedek alınmış bir kopyada)

## 10. Sorun giderme

| Belirti | Çözüm |
|---|---|
| Yedek: "Cannot open backup device … Access is denied" | `backups` klasörü root sahipliğinde (§5.4: `sudo chown 10001:10001 backups`) |
| Disk beklenenden küçük | LVM kök bölümü genişletilmemiş (§2.2) |
| Docker imaj çekemiyor / `apt` çalışmıyor | Kurumsal proxy (§3) |
| `permission denied ... docker.sock` | `usermod -aG docker` sonrası oturumu kapatıp açmadınız |
| SSH bağlantısı koptu, tekrar bağlanılamıyor | `ufw` SSH kuralı olmadan açıldı; sanal makine konsolundan (hipervizör) `sudo ufw allow 22/tcp` |
| Sunucunun IP'sinden arayüze erişilemiyor, sunucuda `curl -k https://localhost` çalışıyor | Kurumsal güvenlik duvarında 443; `ufw status` |
| Edge Kontrol: Node-RED'e ulaşılamadı | Sunucu → HUBBOX:1880 erişimi (kurumsal güvenlik duvarı), edge adresi |
| Makine "Bağlantı yok", HUBBOX'ta veri var | HUBBOX → sunucu:8883 erişimi; `FLOW_MQTT_HOST` HUBBOX'tan erişilebilen adres mi ve sertifikanın SAN'ında mı? HUBBOX'ta `FLOW_MQTT_CA_FILE` yolunda `ca.crt` var mı? HUBBOX Node-RED loglarında TLS hatası. EMQX panelinde (SSH tüneliyle, §4) istemci listesi |
| Arayüzde "Edge saati kaymış" | HUBBOX'ın NTP ayarı |
| Sunucu saati kaymış | `timedatectl`; NTP sunucusu (§2.3) erişilebilir mi (UDP 123) |
| Disk doluyor | `docker system df`; ham telemetri saklama süresi (Tanımlar → Fabrika ayarları); `backups/` içindeki eski yedekler (`BACKUP_KEEP_DAYS`) |
