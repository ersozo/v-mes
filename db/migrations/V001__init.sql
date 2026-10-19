-- V001: MES_DB başlangıç şeması
-- Kurallar: tüm zaman damgaları UTC datetime2; kodlar/slug'lar küçük harf [a-z0-9-].

------------------------------------------------------------------------------
-- Ayarlar ve kullanıcılar
------------------------------------------------------------------------------
CREATE TABLE dbo.plant_settings (
    [key]       varchar(64)    NOT NULL CONSTRAINT pk_plant_settings PRIMARY KEY,
    value       nvarchar(400)  NOT NULL,
    updated_at  datetime2(3)   NOT NULL CONSTRAINT df_plant_settings_updated DEFAULT SYSUTCDATETIME()
);

INSERT INTO dbo.plant_settings ([key], value) VALUES
    ('timezone', N'Europe/Istanbul'),
    ('min_downtime_seconds', N'60'),
    ('raw_retention_days', N'180'),
    ('edge_heartbeat_timeout_seconds', N'30');

CREATE TABLE dbo.users (
    id             int IDENTITY(1,1) NOT NULL CONSTRAINT pk_users PRIMARY KEY,
    username       varchar(64)    NOT NULL CONSTRAINT uq_users_username UNIQUE,
    display_name   nvarchar(100)  NULL,
    password_hash  varchar(255)   NOT NULL,
    role           varchar(16)    NOT NULL CONSTRAINT ck_users_role CHECK (role IN ('admin', 'engineer', 'operator', 'viewer')),
    is_active      bit            NOT NULL CONSTRAINT df_users_active DEFAULT 1,
    created_at     datetime2(3)   NOT NULL CONSTRAINT df_users_created DEFAULT SYSUTCDATETIME(),
    last_login_at  datetime2(3)   NULL
);

CREATE TABLE dbo.user_refresh_tokens (
    id          bigint IDENTITY(1,1) NOT NULL CONSTRAINT pk_user_refresh_tokens PRIMARY KEY,
    user_id     int           NOT NULL CONSTRAINT fk_refresh_tokens_user REFERENCES dbo.users (id) ON DELETE CASCADE,
    token_hash  char(64)      NOT NULL CONSTRAINT uq_refresh_tokens_hash UNIQUE,   -- SHA-256 hex; ham token saklanmaz
    expires_at  datetime2(3)  NOT NULL,
    revoked_at  datetime2(3)  NULL,
    created_at  datetime2(3)  NOT NULL CONSTRAINT df_refresh_tokens_created DEFAULT SYSUTCDATETIME()
);
CREATE INDEX ix_refresh_tokens_user ON dbo.user_refresh_tokens (user_id);

------------------------------------------------------------------------------
-- ISA-95 hiyerarşisi
------------------------------------------------------------------------------
CREATE TABLE dbo.areas (
    id          int IDENTITY(1,1) NOT NULL CONSTRAINT pk_areas PRIMARY KEY,
    slug        varchar(64)    NOT NULL CONSTRAINT uq_areas_slug UNIQUE,
    name        nvarchar(100)  NOT NULL,
    sort_order  int            NOT NULL CONSTRAINT df_areas_sort DEFAULT 0,
    CONSTRAINT ck_areas_slug CHECK (slug NOT LIKE '%[^a-z0-9-]%' COLLATE Latin1_General_BIN AND LEN(slug) > 0)
);

CREATE TABLE dbo.lines (
    id          int IDENTITY(1,1) NOT NULL CONSTRAINT pk_lines PRIMARY KEY,
    area_id     int            NOT NULL CONSTRAINT fk_lines_area REFERENCES dbo.areas (id),
    slug        varchar(64)    NOT NULL,
    name        nvarchar(100)  NOT NULL,
    edge_id     varchar(64)    NOT NULL CONSTRAINT df_lines_edge DEFAULT 'edge-01',  -- hattı sorgulayan Node-RED örneği
    sort_order  int            NOT NULL CONSTRAINT df_lines_sort DEFAULT 0,
    CONSTRAINT uq_lines_area_slug UNIQUE (area_id, slug),
    CONSTRAINT ck_lines_slug CHECK (slug NOT LIKE '%[^a-z0-9-]%' COLLATE Latin1_General_BIN AND LEN(slug) > 0),
    CONSTRAINT ck_lines_edge CHECK (edge_id NOT LIKE '%[^a-z0-9-]%' COLLATE Latin1_General_BIN AND LEN(edge_id) > 0)
);

CREATE TABLE dbo.machines (
    id                    int IDENTITY(1,1) NOT NULL CONSTRAINT pk_machines PRIMARY KEY,
    line_id               int            NOT NULL CONSTRAINT fk_machines_line REFERENCES dbo.lines (id),
    code                  varchar(64)    NOT NULL CONSTRAINT uq_machines_code UNIQUE,  -- UNS'deki machine_code; değişmez
    name                  nvarchar(100)  NOT NULL,
    is_active             bit            NOT NULL CONSTRAINT df_machines_active DEFAULT 1,
    state_source          varchar(16)    NOT NULL CONSTRAINT df_machines_state_source DEFAULT 'tag',
    counter_idle_seconds  int            NOT NULL CONSTRAINT df_machines_idle DEFAULT 120,
    scrap_source          varchar(16)    NOT NULL CONSTRAINT df_machines_scrap_source DEFAULT 'manual',
    sort_order            int            NOT NULL CONSTRAINT df_machines_sort DEFAULT 0,
    created_at            datetime2(3)   NOT NULL CONSTRAINT df_machines_created DEFAULT SYSUTCDATETIME(),
    updated_at            datetime2(3)   NOT NULL CONSTRAINT df_machines_updated DEFAULT SYSUTCDATETIME(),
    CONSTRAINT ck_machines_code CHECK (code NOT LIKE '%[^a-z0-9-]%' COLLATE Latin1_General_BIN AND LEN(code) > 0),
    CONSTRAINT ck_machines_state_source CHECK (state_source IN ('tag', 'counter')),
    CONSTRAINT ck_machines_scrap_source CHECK (scrap_source IN ('plc', 'manual')),
    CONSTRAINT ck_machines_idle CHECK (counter_idle_seconds BETWEEN 5 AND 3600)
);
CREATE INDEX ix_machines_line ON dbo.machines (line_id);

-- tags_json: [{ "name": "total_count", "address": "DB1,DINT0", "role": "total_count", "unit": "pcs" }, ...]
-- İçerik kuralları (zorunlu roller, adres sözdizimi) uygulama katmanında doğrulanır (packages/contracts).
CREATE TABLE dbo.machine_plc_configs (
    machine_id  int            NOT NULL CONSTRAINT pk_machine_plc_configs PRIMARY KEY
                               CONSTRAINT fk_plc_configs_machine REFERENCES dbo.machines (id) ON DELETE CASCADE,
    protocol    varchar(16)    NOT NULL CONSTRAINT df_plc_configs_protocol DEFAULT 's7',
    host        varchar(253)   NOT NULL,
    port        int            NOT NULL CONSTRAINT df_plc_configs_port DEFAULT 102,
    rack        smallint       NOT NULL CONSTRAINT df_plc_configs_rack DEFAULT 0,
    slot        smallint       NOT NULL CONSTRAINT df_plc_configs_slot DEFAULT 1,
    poll_ms     int            NOT NULL CONSTRAINT df_plc_configs_poll DEFAULT 1000,
    tags_json   nvarchar(max)  NOT NULL,
    updated_at  datetime2(3)   NOT NULL CONSTRAINT df_plc_configs_updated DEFAULT SYSUTCDATETIME(),
    updated_by  int            NULL CONSTRAINT fk_plc_configs_user REFERENCES dbo.users (id),
    CONSTRAINT ck_plc_configs_protocol CHECK (protocol IN ('s7')),
    CONSTRAINT ck_plc_configs_port CHECK (port BETWEEN 1 AND 65535),
    CONSTRAINT ck_plc_configs_rack_slot CHECK (rack BETWEEN 0 AND 7 AND slot BETWEEN 0 AND 31),
    CONSTRAINT ck_plc_configs_poll CHECK (poll_ms BETWEEN 100 AND 60000),
    CONSTRAINT ck_plc_configs_tags_json CHECK (ISJSON(tags_json) = 1)
);

------------------------------------------------------------------------------
-- Ürünler, vardiyalar, duruş nedenleri
------------------------------------------------------------------------------
CREATE TABLE dbo.products (
    id         int IDENTITY(1,1) NOT NULL CONSTRAINT pk_products PRIMARY KEY,
    code       varchar(64)    NOT NULL CONSTRAINT uq_products_code UNIQUE,
    name       nvarchar(200)  NOT NULL,
    is_active  bit            NOT NULL CONSTRAINT df_products_active DEFAULT 1
);

CREATE TABLE dbo.product_machine_rates (
    product_id           int            NOT NULL CONSTRAINT fk_rates_product REFERENCES dbo.products (id) ON DELETE CASCADE,
    machine_id           int            NOT NULL CONSTRAINT fk_rates_machine REFERENCES dbo.machines (id) ON DELETE CASCADE,
    ideal_cycle_seconds  decimal(10, 3) NOT NULL CONSTRAINT ck_rates_cycle CHECK (ideal_cycle_seconds > 0),
    CONSTRAINT pk_product_machine_rates PRIMARY KEY (product_id, machine_id)
);

-- Duruş kategorisinin OEE etkisi:
--   planned    → Planlı Süre'den düşülür (Availability'yi etkilemez)
--   unplanned  → Availability kaybı
--   changeover → Availability kaybı (raporlarda ayrı gösterilir)
CREATE TABLE dbo.downtime_reasons (
    id         int IDENTITY(1,1) NOT NULL CONSTRAINT pk_downtime_reasons PRIMARY KEY,
    code       varchar(32)    NOT NULL CONSTRAINT uq_downtime_reasons_code UNIQUE,
    name       nvarchar(100)  NOT NULL,
    category   varchar(16)    NOT NULL CONSTRAINT ck_downtime_reasons_category CHECK (category IN ('unplanned', 'planned', 'changeover')),
    parent_id  int            NULL CONSTRAINT fk_downtime_reasons_parent REFERENCES dbo.downtime_reasons (id),
    is_active  bit            NOT NULL CONSTRAINT df_downtime_reasons_active DEFAULT 1,
    sort_order int            NOT NULL CONSTRAINT df_downtime_reasons_sort DEFAULT 0
);

-- Fabrika geneli vardiya tanımları (yerel saat). end_local < start_local ise vardiya gece yarısını aşar.
-- days_mask: vardiyanın BAŞLADIĞI gün; bit0 = Pazartesi ... bit6 = Pazar.
CREATE TABLE dbo.shift_definitions (
    id           int IDENTITY(1,1) NOT NULL CONSTRAINT pk_shift_definitions PRIMARY KEY,
    name         nvarchar(50)  NOT NULL,
    start_local  time(0)       NOT NULL,
    end_local    time(0)       NOT NULL,
    days_mask    tinyint       NOT NULL CONSTRAINT df_shift_days DEFAULT 127,
    is_active    bit           NOT NULL CONSTRAINT df_shift_active DEFAULT 1,
    CONSTRAINT ck_shift_days CHECK (days_mask BETWEEN 1 AND 127),
    CONSTRAINT ck_shift_times CHECK (start_local <> end_local)
);

-- Vardiya içindeki tekrarlı planlı duruşlar (mola, yemek...).
CREATE TABLE dbo.planned_stop_definitions (
    id                   int IDENTITY(1,1) NOT NULL CONSTRAINT pk_planned_stop_definitions PRIMARY KEY,
    shift_definition_id  int           NOT NULL CONSTRAINT fk_planned_stops_shift REFERENCES dbo.shift_definitions (id) ON DELETE CASCADE,
    name                 nvarchar(50)  NOT NULL,
    start_local          time(0)       NOT NULL,
    duration_minutes     smallint      NOT NULL CONSTRAINT ck_planned_stops_duration CHECK (duration_minutes BETWEEN 1 AND 480)
);

------------------------------------------------------------------------------
-- İş emirleri
------------------------------------------------------------------------------
CREATE TABLE dbo.production_orders (
    id          int IDENTITY(1,1) NOT NULL CONSTRAINT pk_production_orders PRIMARY KEY,
    order_no    varchar(64)   NOT NULL CONSTRAINT uq_production_orders_no UNIQUE,
    product_id  int           NOT NULL CONSTRAINT fk_orders_product REFERENCES dbo.products (id),
    machine_id  int           NOT NULL CONSTRAINT fk_orders_machine REFERENCES dbo.machines (id),
    target_qty  int           NOT NULL CONSTRAINT ck_orders_target CHECK (target_qty > 0),
    status      varchar(16)   NOT NULL CONSTRAINT df_orders_status DEFAULT 'planned',
    created_at  datetime2(3)  NOT NULL CONSTRAINT df_orders_created DEFAULT SYSUTCDATETIME(),
    created_by  int           NULL CONSTRAINT fk_orders_created_by REFERENCES dbo.users (id),
    started_at  datetime2(3)  NULL,
    ended_at    datetime2(3)  NULL,
    CONSTRAINT ck_orders_status CHECK (status IN ('planned', 'running', 'paused', 'done', 'cancelled'))
);
-- Bir makinede aynı anda yalnızca bir iş emri çalışabilir.
CREATE UNIQUE INDEX uq_orders_running_per_machine ON dbo.production_orders (machine_id) WHERE status = 'running';
CREATE INDEX ix_orders_machine_status ON dbo.production_orders (machine_id, status);

-- İş emrinin gerçekten çalıştığı aralıklar (duraklat/devam et). Performance hesabında
-- hangi zaman diliminde hangi ürünün (→ ideal çevrim süresinin) geçerli olduğunu belirler.
CREATE TABLE dbo.production_order_runs (
    id                   bigint IDENTITY(1,1) NOT NULL CONSTRAINT pk_production_order_runs PRIMARY KEY,
    production_order_id  int           NOT NULL CONSTRAINT fk_order_runs_order REFERENCES dbo.production_orders (id),
    machine_id           int           NOT NULL CONSTRAINT fk_order_runs_machine REFERENCES dbo.machines (id),
    start_ts             datetime2(3)  NOT NULL,
    end_ts               datetime2(3)  NULL,
    CONSTRAINT ck_order_runs_range CHECK (end_ts IS NULL OR end_ts >= start_ts)
);
CREATE UNIQUE INDEX uq_order_runs_open_per_machine ON dbo.production_order_runs (machine_id) WHERE end_ts IS NULL;
CREATE INDEX ix_order_runs_machine_start ON dbo.production_order_runs (machine_id, start_ts) INCLUDE (end_ts, production_order_id);

------------------------------------------------------------------------------
-- Durum, duruş ve hurda kayıtları
------------------------------------------------------------------------------
CREATE TABLE dbo.machine_state_intervals (
    id          bigint IDENTITY(1,1) NOT NULL CONSTRAINT pk_machine_state_intervals PRIMARY KEY NONCLUSTERED,
    machine_id  int           NOT NULL CONSTRAINT fk_state_intervals_machine REFERENCES dbo.machines (id),
    state       varchar(16)   NOT NULL CONSTRAINT ck_state_intervals_state CHECK (state IN ('running', 'stopped', 'offline')),
    start_ts    datetime2(3)  NOT NULL,
    end_ts      datetime2(3)  NULL,
    CONSTRAINT ck_state_intervals_range CHECK (end_ts IS NULL OR end_ts >= start_ts)
);
CREATE CLUSTERED INDEX cx_state_intervals_machine_start ON dbo.machine_state_intervals (machine_id, start_ts);
CREATE UNIQUE INDEX uq_state_intervals_open_per_machine ON dbo.machine_state_intervals (machine_id) WHERE end_ts IS NULL;

CREATE TABLE dbo.downtime_logs (
    id           bigint IDENTITY(1,1) NOT NULL CONSTRAINT pk_downtime_logs PRIMARY KEY NONCLUSTERED,
    machine_id   int            NOT NULL CONSTRAINT fk_downtime_logs_machine REFERENCES dbo.machines (id),
    start_ts     datetime2(3)   NOT NULL,
    end_ts       datetime2(3)   NULL,
    reason_id    int            NULL CONSTRAINT fk_downtime_logs_reason REFERENCES dbo.downtime_reasons (id),
    assigned_by  int            NULL CONSTRAINT fk_downtime_logs_user REFERENCES dbo.users (id),
    assigned_at  datetime2(3)   NULL,
    note         nvarchar(500)  NULL,
    CONSTRAINT ck_downtime_logs_range CHECK (end_ts IS NULL OR end_ts >= start_ts)
);
CREATE CLUSTERED INDEX cx_downtime_logs_machine_start ON dbo.downtime_logs (machine_id, start_ts);
CREATE UNIQUE INDEX uq_downtime_logs_open_per_machine ON dbo.downtime_logs (machine_id) WHERE end_ts IS NULL;
CREATE INDEX ix_downtime_logs_unassigned ON dbo.downtime_logs (machine_id, start_ts) WHERE reason_id IS NULL;

CREATE TABLE dbo.manual_scrap_entries (
    id                   bigint IDENTITY(1,1) NOT NULL CONSTRAINT pk_manual_scrap_entries PRIMARY KEY,
    machine_id           int            NOT NULL CONSTRAINT fk_scrap_machine REFERENCES dbo.machines (id),
    production_order_id  int            NULL CONSTRAINT fk_scrap_order REFERENCES dbo.production_orders (id),
    ts                   datetime2(3)   NOT NULL,
    qty                  int            NOT NULL CONSTRAINT ck_scrap_qty CHECK (qty > 0),
    reason               nvarchar(200)  NULL,
    entered_by           int            NULL CONSTRAINT fk_scrap_user REFERENCES dbo.users (id),
    created_at           datetime2(3)   NOT NULL CONSTRAINT df_scrap_created DEFAULT SYSUTCDATETIME()
);
CREATE INDEX ix_scrap_machine_ts ON dbo.manual_scrap_entries (machine_id, ts) INCLUDE (qty);

------------------------------------------------------------------------------
-- Zaman serisi
------------------------------------------------------------------------------
-- Aylık partition (RANGE RIGHT: her sınır ayın ilk günüdür). Gelecek aylar
-- dbo.usp_telemetry_ensure_partitions ile otomatik eklenir.
CREATE PARTITION FUNCTION pf_telemetry_month (datetime2(3)) AS RANGE RIGHT FOR VALUES (
    '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01',
    '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01',
    '2027-01-01', '2027-02-01', '2027-03-01'
);
CREATE PARTITION SCHEME ps_telemetry_month AS PARTITION pf_telemetry_month ALL TO ([PRIMARY]);

-- Ham telemetri, long format. FK yok (yüksek hızlı bulk insert için).
CREATE TABLE dbo.machine_telemetry (
    machine_id  int           NOT NULL,
    tag_name    varchar(64)   NOT NULL,
    ts          datetime2(3)  NOT NULL,
    value       float         NOT NULL
) ON ps_telemetry_month (ts);
CREATE CLUSTERED COLUMNSTORE INDEX cci_machine_telemetry ON dbo.machine_telemetry ON ps_telemetry_month (ts);

-- Dakikalık sayaç artışları (ingestion yazar; sıfırlanmalar ele alınmış hâlde). OEE buradan hesaplanır.
CREATE TABLE dbo.counter_deltas_1m (
    machine_id  int           NOT NULL,
    bucket_ts   datetime2(0)  NOT NULL,   -- dakikanın başlangıcı (UTC)
    role        varchar(16)   NOT NULL CONSTRAINT ck_counter_deltas_role CHECK (role IN ('total_count', 'scrap_count')),
    delta       bigint        NOT NULL CONSTRAINT ck_counter_deltas_delta CHECK (delta >= 0),
    CONSTRAINT pk_counter_deltas_1m PRIMARY KEY CLUSTERED (machine_id, bucket_ts, role)
);

-- Ingestion yeniden başladığında fark hesabına kaldığı yerden devam etmesi için son sayaç değerleri.
CREATE TABLE dbo.counter_state (
    machine_id  int           NOT NULL,
    role        varchar(16)   NOT NULL,
    last_value  bigint        NOT NULL,
    last_ts     datetime2(3)  NOT NULL,
    CONSTRAINT pk_counter_state PRIMARY KEY (machine_id, role)
);

CREATE TABLE dbo.ingest_dead_letters (
    id           bigint IDENTITY(1,1) NOT NULL CONSTRAINT pk_ingest_dead_letters PRIMARY KEY,
    received_at  datetime2(3)    NOT NULL CONSTRAINT df_dead_letters_received DEFAULT SYSUTCDATETIME(),
    topic        nvarchar(512)   NOT NULL,
    payload      nvarchar(max)   NULL,
    error        nvarchar(2000)  NOT NULL
);
CREATE INDEX ix_dead_letters_received ON dbo.ingest_dead_letters (received_at);

------------------------------------------------------------------------------
-- Node-RED deploy geçmişi
------------------------------------------------------------------------------
CREATE TABLE dbo.flow_deployments (
    id            int IDENTITY(1,1) NOT NULL CONSTRAINT pk_flow_deployments PRIMARY KEY,
    deployed_at   datetime2(3)   NOT NULL CONSTRAINT df_flow_deployments_at DEFAULT SYSUTCDATETIME(),
    deployed_by   int            NULL CONSTRAINT fk_flow_deployments_user REFERENCES dbo.users (id),
    status        varchar(16)    NOT NULL CONSTRAINT ck_flow_deployments_status CHECK (status IN ('success', 'partial', 'failed')),
    summary_json  nvarchar(max)  NULL CONSTRAINT ck_flow_deployments_summary CHECK (summary_json IS NULL OR ISJSON(summary_json) = 1),
    error         nvarchar(max)  NULL
);
GO

------------------------------------------------------------------------------
-- Bakım yordamları (EXECUTE AS OWNER: uygulama kullanıcısı DDL yetkisi olmadan çağırabilir)
------------------------------------------------------------------------------

-- Bugünden itibaren @months_ahead ay sonrasına kadar partition sınırlarını garanti eder.
CREATE PROCEDURE dbo.usp_telemetry_ensure_partitions
    @months_ahead int = 3
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @target datetime2(3) = DATEADD(MONTH, @months_ahead, DATEFROMPARTS(YEAR(SYSUTCDATETIME()), MONTH(SYSUTCDATETIME()), 1));
    DECLARE @max datetime2(3);

    SELECT @max = MAX(CAST(v.value AS datetime2(3)))
    FROM sys.partition_range_values v
    JOIN sys.partition_functions f ON f.function_id = v.function_id
    WHERE f.name = 'pf_telemetry_month';

    WHILE @max < @target
    BEGIN
        SET @max = DATEADD(MONTH, 1, @max);
        ALTER PARTITION SCHEME ps_telemetry_month NEXT USED [PRIMARY];
        ALTER PARTITION FUNCTION pf_telemetry_month() SPLIT RANGE (@max);
    END
END
GO

-- Tamamı saklama süresinden eski olan aylık partition'ları boşaltır ve sınırlarını birleştirir.
CREATE PROCEDURE dbo.usp_telemetry_purge
    @retention_days int
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;
    IF @retention_days IS NULL OR @retention_days < 1
        THROW 50001, 'retention_days en az 1 olmalı', 1;

    DECLARE @cutoff datetime2(3) = DATEADD(DAY, -@retention_days, SYSUTCDATETIME());
    DECLARE @boundary datetime2(3), @partition int, @sql nvarchar(400);

    -- RANGE RIGHT: partition N+1, N. sınırdan başlar; partition 1 ilk sınırdan öncesidir.
    -- Üst sınırı (bir sonraki sınır) @cutoff'tan küçük/eşit olan partition'lar tamamen eskidir.
    DECLARE c CURSOR LOCAL FAST_FORWARD FOR
        SELECT CAST(v.value AS datetime2(3)), v.boundary_id
        FROM sys.partition_range_values v
        JOIN sys.partition_functions f ON f.function_id = v.function_id
        WHERE f.name = 'pf_telemetry_month' AND CAST(v.value AS datetime2(3)) <= @cutoff
        ORDER BY v.boundary_id;

    OPEN c;
    FETCH NEXT FROM c INTO @boundary, @partition;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        -- boundary_id = N sınırının altında kalan partition N'dir.
        SET @sql = N'TRUNCATE TABLE dbo.machine_telemetry WITH (PARTITIONS (' + CAST(@partition AS nvarchar(10)) + N'));';
        EXEC sys.sp_executesql @sql;
        FETCH NEXT FROM c INTO @boundary, @partition;
    END
    CLOSE c;
    DEALLOCATE c;

    -- Boşalan baştaki partition'ları birleştir (en eski sınırdan başlayarak).
    WHILE 1 = 1
    BEGIN
        SET @boundary = NULL;
        SELECT TOP (1) @boundary = CAST(v.value AS datetime2(3))
        FROM sys.partition_range_values v
        JOIN sys.partition_functions f ON f.function_id = v.function_id
        WHERE f.name = 'pf_telemetry_month' AND CAST(v.value AS datetime2(3)) <= @cutoff
        ORDER BY v.boundary_id;

        IF @boundary IS NULL BREAK;
        -- Sınırın iki tarafı da boşsa birleştirme veri taşımaz.
        IF EXISTS (SELECT 1 FROM dbo.machine_telemetry WHERE ts >= DATEADD(MONTH, -1, @boundary) AND ts < DATEADD(MONTH, 1, @boundary)) BREAK;
        ALTER PARTITION FUNCTION pf_telemetry_month() MERGE RANGE (@boundary);
    END

    DELETE FROM dbo.ingest_dead_letters WHERE received_at < DATEADD(DAY, -7, SYSUTCDATETIME());
END
GO

-- Kapanmış (dolmuş) delta rowgroup'ları sıkıştırır. Gece çalıştırılır.
CREATE PROCEDURE dbo.usp_telemetry_compress
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;
    ALTER INDEX cci_machine_telemetry ON dbo.machine_telemetry REORGANIZE;
END
GO
