# V-MES Kurulum Rehberi — Windows sanal makine + WSL2

Bu rehber V-MES'i kurumsal ağdaki bir **Windows sanal makinede, WSL2 (Ubuntu) içinde Docker ile** 7/24 çalışacak şekilde kurar. Genel bilgi ve komutlar için [README](../README.md), mimari için [ARCHITECTURE](../ARCHITECTURE.md).

> **Linux sanal makine kullanabiliyorsanız tercih edin:** [KURULUM-UBUNTU.md](KURULUM-UBUNTU.md). Aşağıdaki adımların yaklaşık yarısı (iç içe sanallaştırma, açılışta otomatik başlatma, boşta kapanma, ağ yönlendirme) WSL'e özgüdür.
>
> **Not:** Üretim katmanı MQTT'yi yalnızca TLS (8883) ile dışarı açar; bu rehberde geçen 1883 seçenekleri üretimde geçerli değildir. HUBBOX ayarları için Ubuntu rehberinin §6.1'ine bakın (`FLOW_MQTT_TLS=true`, her HUBBOX'ta `ca.crt`). Yedek klasörü sahipliği de aynı şekilde gereklidir (Ubuntu rehberi §5.4).

---

## İçindekiler

0. [Hazırlık: bilgi ve izin listesi](#0-hazırlık-bilgi-ve-izin-listesi)
1. [Sanal makine gereksinimleri](#1-sanal-makine-gereksinimleri)
2. [WSL2 ve Ubuntu kurulumu](#2-wsl2-ve-ubuntu-kurulumu)
3. [WSL ayarları (.wslconfig, wsl.conf)](#3-wsl-ayarları)
4. [Docker Engine kurulumu](#4-docker-engine-kurulumu)
5. [Ağ: kurumsal ağdan erişim](#5-ağ-kurumsal-ağdan-erişim)
6. [Açılışta otomatik başlatma](#6-açılışta-otomatik-başlatma)
7. [V-MES kurulumu](#7-v-mes-kurulumu)
8. [HUBBOX bağlantısı ve ilk makine](#8-hubbox-bağlantısı-ve-ilk-makine)
9. [Yedekleme](#9-yedekleme)
10. [Kabul testi (kontrol listesi)](#10-kabul-testi)
11. [Sorun giderme](#11-sorun-giderme)

---

## 0. Hazırlık: bilgi ve izin listesi

Kuruluma başlamadan IT ile şunları netleştirin:

| # | Konu | Ayrıntı |
|---|---|---|
| 1 | Sanal makine | Windows 11 22H2+ veya Windows Server 2022/2025; **iç içe sanallaştırma açık** (bkz. §1) |
| 2 | Sabit IP | Sanal makinenin kurumsal ağdaki IP'si sabit olmalı (HUBBOX'lar MQTT'yi bu adrese gönderir). Bir DNS adı da (ör. `mes.fabrika.local`) önerilir |
| 3 | Gelen erişim → sanal makine | **TCP 443** (arayüz; kullanıcılar/tabletler), **TCP 1883** veya TLS ile **8883** (HUBBOX'lardan MQTT) |
| 4 | Giden erişim sanal makine → HUBBOX'lar | **TCP 1880** (Node-RED Admin API; akış dağıtımı) — her HUBBOX için |
| 5 | Kurulum sırasında internet | Docker imajları ve Ubuntu paketleri için (proxy varsa adresi) |
| 6 | Saat | Sanal makine ve **tüm HUBBOX'lar** kurumsal NTP sunucusuna senkron |
| 7 | Sertifika | `mes.fabrika.local` (ve/veya IP) için kurumsal CA'dan sunucu sertifikası; yoksa kendinden imzalı (bkz. §7.3) |
| 8 | Yedek hedefi | Günlük veritabanı yedeklerinin kopyalanacağı ağ paylaşımı |

## 1. Sanal makine gereksinimleri

| Kaynak | Öneri | Not |
|---|---|---|
| vCPU | 4 | |
| RAM | 16 GB | WSL'e 8–10 GB ayrılır (MS SQL ~2–4 GB) |
| Disk | 150 GB SSD | Telemetri saklama süresine göre (varsayılan 180 gün) |
| İşletim sistemi | Windows 11 22H2+ / Windows Server 2022+ | "Mirrored" ağ modu Windows 11 22H2+ gerektirir; Server'da desteği kontrol edin, yoksa §5.B |

### İç içe sanallaştırma (zorunlu)

WSL2 kendisi hafif bir sanal makinedir. Uygulama zaten bir sanal makinede çalışacağı için **hipervizörde iç içe sanallaştırmanın açılması gerekir**; aksi halde `wsl --install` "Virtual Machine Platform" hatası verir. Bunu sanal makine kapalıyken IT yapar:

- **Hyper-V** (sunucuda, PowerShell yönetici):
  ```powershell
  Set-VMProcessor -VMName "<SANAL-MAKINE-ADI>" -ExposeVirtualizationExtensions $true
  ```
- **VMware vSphere/ESXi:** Sanal makine ayarları → CPU → *Expose hardware assisted virtualization to the guest OS* işaretli.
- **Diğer hipervizörler:** "nested virtualization" ayarı.

## 2. WSL2 ve Ubuntu kurulumu

Sanal makinede **PowerShell (Yönetici)**:

```powershell
wsl --install -d Ubuntu-24.04
```

Yeniden başlatmanın ardından Ubuntu açılır ve bir Linux kullanıcı adı/şifresi ister (ör. `mesadmin`). Sonra:

```powershell
wsl --update
wsl --version          # WSL 2.x olmalı
wsl -l -v              # Ubuntu-24.04, VERSION 2
```

## 3. WSL ayarları

### 3.1 Windows tarafı: `%UserProfile%\.wslconfig`

Not Defteri ile `C:\Users\<kullanıcı>\.wslconfig` dosyasını oluşturun (WSL'i çalıştıracak Windows hesabının profilinde):

```ini
[wsl2]
memory=10GB
processors=4
swap=4GB
# Kurumsal ağdan WSL'deki servislere doğrudan erişim (Windows 11 22H2+)
networkingMode=mirrored
# WSL sanal makinesinin boştayken kapanmasını engelle (7/24 servis)
vmIdleTimeout=-1

[general]
# Dağıtımın, açık terminal yokken kapanmasını engelle (WSL 2.x)
instanceIdleTimeout=-1
```

> Ayar adları WSL sürümüne göre değişebilir; `wsl --version` ile 2.x olduğundan emin olun. Ayarların işe yaradığını §10'daki yeniden başlatma testi doğrular.

### 3.2 Linux tarafı: `/etc/wsl.conf`

Ubuntu içinde:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true

[network]
hostname=mes-wsl
EOF
```

PowerShell'de WSL'i yeniden başlatın ve systemd'yi doğrulayın:

```powershell
wsl --shutdown
wsl -d Ubuntu-24.04 -- systemctl is-system-running    # "running" veya "degraded" olmalı
```

### 3.3 Saat dilimi ve saat

```bash
sudo timedatectl set-timezone Europe/Istanbul
timedatectl          # "System clock synchronized: yes" görülmeli (Windows saatini kullanır)
```

Uygulama içi tüm zamanlar UTC tutulur; bu ayar yalnızca log okumayı kolaylaştırır.

## 4. Docker Engine kurulumu

> **Docker Desktop yerine WSL içinde Docker Engine kurulur.** Docker Desktop, 250'den fazla çalışanı veya 10 milyon USD üzeri cirosu olan şirketlerde ücretli abonelik gerektirir ve bir kullanıcının oturum açmasına bağlıdır. Docker Engine açık kaynaklıdır ve systemd servisi olarak çalışır.

Ubuntu içinde ([Docker'ın resmi talimatları](https://docs.docker.com/engine/install/ubuntu/)):

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git make
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo systemctl enable --now docker containerd
sudo usermod -aG docker $USER          # oturumu kapatıp açın (exit → wsl)
docker run --rm hello-world
docker compose version                 # v2.24+ olmalı
```

**Kurumsal proxy varsa** Docker'ın imaj çekebilmesi için:

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

## 5. Ağ: kurumsal ağdan erişim

WSL2 varsayılan olarak Windows'un arkasında NAT'lı bir ağdadır; kurumsal ağdaki tabletler ve HUBBOX'lar WSL'deki servislere doğrudan ulaşamaz. İki yöntem vardır.

### 5.A Mirrored mod (önerilen)

§3.1'deki `networkingMode=mirrored` ile WSL, Windows'un ağ arayüzlerini paylaşır: WSL'de 443'ü dinleyen servis, sanal makinenin kurumsal IP'sinde 443'ten erişilebilir olur. Ek olarak **iki katman güvenlik duvarı** açılmalıdır. PowerShell (Yönetici):

```powershell
# 1) Hyper-V güvenlik duvarı: WSL'e gelen bağlantılara izin ver
Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow

# 2) Windows Defender güvenlik duvarı: yalnızca gereken portlar
New-NetFirewallRule -DisplayName "V-MES HTTPS"  -Direction Inbound -Protocol TCP -LocalPort 443  -Action Allow
New-NetFirewallRule -DisplayName "V-MES HTTP→HTTPS" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow
New-NetFirewallRule -DisplayName "V-MES MQTT (HUBBOX)" -Direction Inbound -Protocol TCP -LocalPort 1883 -Action Allow -RemoteAddress <HUBBOX-ALT-AĞI>   # ör. 10.146.168.0/24
# TLS kullanılacaksa 1883 yerine 8883
```

> MQTT kuralındaki `-RemoteAddress` ile MQTT portunu yalnızca HUBBOX'ların bulunduğu ağa açın.

### 5.B NAT modu + port yönlendirme (mirrored kullanılamıyorsa)

WSL'in IP'si her yeniden başlatmada değişir; bu yüzden yönlendirme bir betikle açılışta yenilenir. `C:\vmes\wsl-portproxy.ps1`:

```powershell
$wslIp = (wsl -d Ubuntu-24.04 -- hostname -I).Trim().Split(" ")[0]
foreach ($port in 80, 443, 1883) {
  netsh interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 | Out-Null
  netsh interface portproxy add v4tov4 listenport=$port listenaddress=0.0.0.0 connectport=$port connectaddress=$wslIp
}
```

Bu betiği §6'daki görevden sonra çalışacak ikinci bir zamanlanmış görev olarak ekleyin; güvenlik duvarı kuralları 5.A'daki 2. adımla aynıdır (Hyper-V kuralı gerekmez).

## 6. Açılışta otomatik başlatma

WSL, Windows açıldığında kendiliğinden başlamaz. Bir **zamanlanmış görev** WSL'i başlatır ve açık tutar; Docker konteynerleri `restart: unless-stopped` ile kendiliğinden ayağa kalkar.

PowerShell (Yönetici) — `<WINDOWS-HESABI>` WSL'in kurulu olduğu hesaptır (§3.1'deki `.wslconfig` bu hesabın profilinde olmalı):

```powershell
$action  = New-ScheduledTaskAction -Execute "wsl.exe" -Argument "-d Ubuntu-24.04 --exec /bin/sh -c 'sleep infinity'"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "V-MES WSL" -Action $action -Trigger $trigger -Settings $settings `
            -User "<WINDOWS-HESABI>" -Password (Read-Host "Şifre") -RunLevel Highest
```

- "Kullanıcı oturum açmış olsun ya da olmasın çalıştır" davranışı `-User/-Password` ile sağlanır.
- `sleep infinity` dağıtımı açık tutar; systemd Docker'ı başlatır.
- Windows güncellemeleri sonrası otomatik yeniden başlatmalar bu görev sayesinde kesintiyi dakikalarla sınırlar. Edge'ler bu sürede MQTT'ye bağlanamaz; Node-RED yeniden bağlanır, kesinti süresi raporlarda "veri yok" olarak görünür (OEE'ye katılmaz).

## 7. V-MES kurulumu

Tüm komutlar Ubuntu içinde. **Kodu Linux dosya sisteminde tutun** (`/opt` veya `~`); `/mnt/c/...` altında çalıştırmak hem yavaştır hem de dosya izinlerini bozar.

### 7.1 Kodu alın

```bash
sudo mkdir -p /opt/v-mes && sudo chown $USER: /opt/v-mes
git clone <DEPO-ADRESİ> /opt/v-mes
cd /opt/v-mes
```

### 7.2 Ortam dosyası

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
| `MSSQL_PID` | Lisansınız: `Express` (10 GB sınırı), `Standard`, `Enterprise` |
| Portlar | Varsayılanlar (1433, 1883 …) kalabilir; üretim katmanı iç portları dışarı açmaz |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | İlk yönetici; ilk girişten sonra arayüzden kişisel hesaplar açıp bunu kaldırabilirsiniz |
| `EDGE_*`, `FLOW_MQTT_*` | §8'de |

### 7.3 Sertifikalar

Kurumsal CA'dan alınan dosyaları koyun:

```bash
mkdir -p infra/certs
cp /mnt/c/Users/<kullanıcı>/Downloads/{server.crt,server.key,ca.crt} infra/certs/
chmod 640 infra/certs/server.key
```

Kurumsal sertifika henüz yoksa geçici olarak kendinden imzalı (sanal makinenin adı ve IP'si ile):

```bash
scripts/gen-certs.sh mes.fabrika.local 10.146.x.x
```

Bu durumda `infra/certs/ca.crt` dosyasını kullanıcıların tarayıcılarına/tabletlerine güvenilir kök sertifika olarak yükleyin.

### 7.4 Başlatma

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose run --rm db-migrate
docker compose ps        # tüm servisler "healthy"
```

İlk derleme internet hızına göre 5–15 dakika sürer. Tarayıcıdan `https://mes.fabrika.local` (veya IP) ile giriş yapın.

> Üretim kurulumunda örnek veri (`make seed`) **yüklemeyin**; alan/hat/makine, ürün, vardiya ve duruş nedenlerini arayüzden tanımlayın. Duruş nedenleri için seed dosyasındaki listeyi başlangıç noktası olarak kullanabilirsiniz.

Kolaylık için kısa yol (Ubuntu'da `~/.bashrc` sonuna):

```bash
alias mes='docker compose -f /opt/v-mes/docker-compose.yml -f /opt/v-mes/docker-compose.prod.yml --project-directory /opt/v-mes'
# kullanım: mes ps, mes logs -f ingestion, mes restart api
```

## 8. HUBBOX bağlantısı ve ilk makine

### 8.1 Ayarlar (tüm HUBBOX'lar için ortak)

`.env` içinde:

```ini
EDGE_NODERED_USER=<HUBBOX Node-RED kullanıcısı>
EDGE_NODERED_PASSWORD=<HUBBOX Node-RED şifresi>
FLOW_MQTT_MODE=inline
FLOW_MQTT_HOST=<sanal makinenin kurumsal IP'si>
FLOW_MQTT_USER=<MQTT_NODERED_USER ile aynı>
FLOW_MQTT_PASSWORD=<MQTT_NODERED_PASSWORD ile aynı>
```

```bash
mes up -d api            # yeni ayarlarla API'yi yeniden oluştur
```

### 8.2 HUBBOX'ı ekleyin

Arayüzde **Edge cihazları → Edge ekle**: kod (ör. `hubbox-mekanik`), ad, Node-RED adresi (`http://10.146.168.19:1880`). Ardından **Kontrol**: tüm maddeler ✓ olmalı. Geliştirmeden kalan `edge-01` kaydını silin veya pasifleştirin.

HUBBOX'tan sanal makinenin MQTT portuna erişimi ayrıca doğrulamak için HUBBOX'taki Node-RED'de geçici bir `mqtt out` düğümüyle `FLOW_MQTT_HOST:1883` adresine bağlanmayı deneyebilirsiniz (bağlandı → yeşil).

### 8.3 İlk makine

Arayüzde **PLC konfigüratörü**:
1. Alan → hat → makine ekleyin; **edge** olarak HUBBOX'ı seçin.
2. PLC: `192.168.10.1`, port 102, rack/slot `0/1` (S7-1500).
3. Tag'ler: **TIA'dan içe aktar** → DB tablosunu (.xlsx) seçin → satırları seçip rolleri atayın (toplam sayaç, çalışıyor bit'i…).
4. **Node-RED dağıtımı** kartında HUBBOX için farkı gözden geçirip **Dağıt**.
5. Canlı panelde makinenin "Çalışıyor/Duruyor" durumuna geçtiğini ve tag değerlerinin aktığını doğrulayın; **Edge cihazları**nda HUBBOX "Çevrimiçi" ve saati "senkron" olmalı.

## 9. Yedekleme

Ubuntu'da günlük yedek ve ağ paylaşımına kopya (`crontab -e`):

```cron
# Her gece 03:00 yedek al, ağ paylaşımına kopyala
0 3 * * * cd /opt/v-mes && ./scripts/backup.sh >> /var/log/vmes-backup.log 2>&1 && cp -n backups/*.bak /mnt/mes-yedek/ 2>>/var/log/vmes-backup.log
```

Ağ paylaşımını bağlamak için (`/etc/fstab`, `cifs-utils` gerekir):

```
//dosya-sunucusu/mes-yedek  /mnt/mes-yedek  cifs  credentials=/root/.smbcred,uid=1000,gid=1000,_netdev  0  0
```

Geri yükleme: README → "Yedekleme ve geri yükleme". **Geri yüklemeyi kurulumdan sonra bir kez deneyin** (bkz. §10).

## 10. Kabul testi

Kurulumu teslim almadan önce:

- [ ] `docker compose ps` → tüm servisler `healthy`
- [ ] Kurumsal ağdaki başka bir bilgisayardan `https://<adres>` açılıyor, sertifika uyarısı yok
- [ ] `http://<adres>` → HTTPS'e yönlendiriyor
- [ ] Dışarıdan 1433 (SQL), 1880 (Node-RED), 18083 (EMQX paneli) portlarına **erişilemiyor**
- [ ] `flow-cli check` → uyumlu
- [ ] İlk makine canlı panelde görünüyor; arayüzün sol alt köşesinde "Canlı" (saat kayması uyarısı yok)
- [ ] **Yeniden başlatma testi:** sanal makineyi yeniden başlatın, **oturum açmadan** 5 dakika bekleyin, başka bir bilgisayardan arayüzü açın → veri akıyor
- [ ] **Boşta kalma testi:** oturumu kapatın, 1 saat sonra arayüz hâlâ canlı
- [ ] **HUBBOX kesintisi:** HUBBOX'ın ağ kablosunu 2 dk çıkarın → makine "Bağlantı yok", edge uyarısı; takınca kendiliğinden düzeliyor
- [ ] `./scripts/backup.sh` çalışıyor, dosya ağ paylaşımına kopyalanıyor
- [ ] Bir test veritabanına geri yükleme denendi (`DB=MES_RESTORE_TEST` ile önce yedek alınmış bir kopyada)

## 11. Sorun giderme

| Belirti | Çözüm |
|---|---|
| `wsl --install`: "Please enable the Virtual Machine Platform" / 0x80370102 | Hipervizörde iç içe sanallaştırma kapalı (§1) |
| Windows yeniden başlayınca uygulama açılmıyor | Görev Zamanlayıcı'da "V-MES WSL" görevinin son çalışma sonucu; `wsl -l -v` → Running mi? `.wslconfig` doğru hesabın profilinde mi? |
| Bir süre sonra uygulama kapanıyor | `vmIdleTimeout` / `instanceIdleTimeout` ayarları uygulanmamış (`wsl --shutdown` sonrası geçerli olur); §6 görevi çalışıyor mu? |
| Sanal makinenin IP'sinden erişilemiyor, WSL içinden `curl localhost` çalışıyor | Mirrored modda Hyper-V güvenlik duvarı kuralı (§5.A-1) veya Windows güvenlik duvarı; NAT modunda portproxy betiği WSL'in güncel IP'siyle çalışmamış |
| Docker imaj çekemiyor | Kurumsal proxy (§4) |
| `flow-cli check`: Node-RED'e ulaşılamadı | Sanal makine → HUBBOX:1880 erişimi (güvenlik duvarı), `EDGE_NODERED_URL` |
| Makine "Bağlantı yok", HUBBOX'ta veri var | HUBBOX → sanal makine:1883 erişimi; `FLOW_MQTT_HOST` sanal makinenin HUBBOX'tan erişilebilen IP'si mi? EMQX panelinde (yalnızca sunucudan: `http://127.0.0.1:18083`) istemci listesi |
| Arayüzde "Edge saati kaymış" | HUBBOX'ın NTP ayarı |
| WSL saati kaymış | `sudo hwclock -s` veya `wsl --shutdown`; Windows saat senkronunu kontrol edin |
| Disk doluyor | `docker system df`; ham telemetri saklama süresi (Tanımlar → Fabrika ayarları); WSL sanal diski (`ext4.vhdx`) kendiliğinden küçülmez — gerekirse IT ile `wsl --manage Ubuntu-24.04 --set-sparse true` |
