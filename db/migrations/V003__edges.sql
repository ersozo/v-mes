-- V003: Edge cihazları (ör. her makinede bir HUBBOX) ve makine bazında edge ataması.
-- Önceki tasarımda edge hat seviyesindeydi (lines.edge_id); her makinenin kendi gateway'i
-- olabileceği için atama makinenin PLC konfigürasyonuna taşınır. Mevcut atamalar korunur.

CREATE TABLE dbo.edges (
    id           int IDENTITY(1,1) NOT NULL CONSTRAINT pk_edges PRIMARY KEY,
    code         varchar(64)    NOT NULL CONSTRAINT uq_edges_code UNIQUE,     -- heartbeat topic'indeki edge_id
    name         nvarchar(100)  NOT NULL,
    nodered_url  varchar(300)   NOT NULL,                                     -- Node-RED Admin API (ör. http://10.146.168.19:1880)
    is_active    bit            NOT NULL CONSTRAINT df_edges_active DEFAULT 1,
    notes        nvarchar(500)  NULL,
    created_at   datetime2(3)   NOT NULL CONSTRAINT df_edges_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT ck_edges_code CHECK (code NOT LIKE '%[^a-z0-9-]%' COLLATE Latin1_General_BIN AND LEN(code) > 0),
    CONSTRAINT ck_edges_url CHECK (nodered_url LIKE 'http://%' OR nodered_url LIKE 'https://%')
);

-- Mevcut hatlardaki edge kimliklerini edge kaydına dönüştür (adres sonradan arayüzden düzenlenir)
INSERT INTO dbo.edges (code, name, nodered_url)
SELECT DISTINCT l.edge_id, l.edge_id, 'http://nodered:1880' FROM dbo.lines l;

ALTER TABLE dbo.machine_plc_configs ADD edge_id int NULL CONSTRAINT fk_plc_configs_edge REFERENCES dbo.edges (id);
ALTER TABLE dbo.flow_deployments ADD edge_id int NULL CONSTRAINT fk_flow_deployments_edge REFERENCES dbo.edges (id);
GO

UPDATE c SET edge_id = e.id
FROM dbo.machine_plc_configs c
JOIN dbo.machines m ON m.id = c.machine_id
JOIN dbo.lines l ON l.id = m.line_id
JOIN dbo.edges e ON e.code = l.edge_id;
GO

ALTER TABLE dbo.machine_plc_configs ALTER COLUMN edge_id int NOT NULL;
CREATE INDEX ix_plc_configs_edge ON dbo.machine_plc_configs (edge_id);

ALTER TABLE dbo.lines DROP CONSTRAINT ck_lines_edge;
ALTER TABLE dbo.lines DROP CONSTRAINT df_lines_edge;
ALTER TABLE dbo.lines DROP COLUMN edge_id;
GO
