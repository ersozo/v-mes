-- Geliştirme verisi (idempotent). Simülatördeki makinelerle birebir eşleşir.
-- S7-1200/1500 simülasyonu: optimize EDİLMEMİŞ DB1, mutlak adresler:
--   DB1.DBD0  DINT  total_count
--   DB1.DBD4  DINT  scrap_count
--   DB1.DBX8.0 BOOL running
--   DB1.DBW10 INT   state_code
--   DB1.DBD12 REAL  (proses değeri 1)
--   DB1.DBD16 REAL  (proses değeri 2)

SET NOCOUNT ON;

-- Hiyerarşi
INSERT INTO dbo.areas (slug, name, sort_order)
SELECT 'talasli-imalat', N'Talaşlı İmalat', 1
WHERE NOT EXISTS (SELECT 1 FROM dbo.areas WHERE slug = 'talasli-imalat');

INSERT INTO dbo.areas (slug, name, sort_order)
SELECT 'pres', N'Pres Atölyesi', 2
WHERE NOT EXISTS (SELECT 1 FROM dbo.areas WHERE slug = 'pres');

INSERT INTO dbo.lines (area_id, slug, name, sort_order)
SELECT a.id, 'hat-1', N'CNC Hattı 1', 1 FROM dbo.areas a
WHERE a.slug = 'talasli-imalat'
  AND NOT EXISTS (SELECT 1 FROM dbo.lines l WHERE l.area_id = a.id AND l.slug = 'hat-1');

INSERT INTO dbo.lines (area_id, slug, name, sort_order)
SELECT a.id, 'hat-1', N'Pres Hattı 1', 1 FROM dbo.areas a
WHERE a.slug = 'pres'
  AND NOT EXISTS (SELECT 1 FROM dbo.lines l WHERE l.area_id = a.id AND l.slug = 'hat-1');

-- Edge: geliştirmede compose'daki Node-RED
INSERT INTO dbo.edges (code, name, nodered_url)
SELECT 'edge-01', N'Geliştirme Node-RED', 'http://nodered:1880'
WHERE NOT EXISTS (SELECT 1 FROM dbo.edges WHERE code = 'edge-01');

-- Makineler: üç farklı durum/hurda kaynağı kombinasyonu
DECLARE @cnc_line int = (SELECT l.id FROM dbo.lines l JOIN dbo.areas a ON a.id = l.area_id WHERE a.slug = 'talasli-imalat' AND l.slug = 'hat-1');
DECLARE @pres_line int = (SELECT l.id FROM dbo.lines l JOIN dbo.areas a ON a.id = l.area_id WHERE a.slug = 'pres' AND l.slug = 'hat-1');

INSERT INTO dbo.machines (line_id, code, name, state_source, scrap_source, sort_order)
SELECT v.line_id, v.code, v.name, v.state_source, v.scrap_source, v.sort_order
FROM (VALUES
    (@cnc_line,  'cnc-01',  N'CNC Torna 01',  'tag',     'plc',    1),
    (@cnc_line,  'cnc-02',  N'CNC Freze 02',  'tag',     'manual', 2),
    (@pres_line, 'pres-01', N'Eksantrik Pres 01', 'counter', 'plc', 1)
) v (line_id, code, name, state_source, scrap_source, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM dbo.machines m WHERE m.code = v.code);

UPDATE dbo.machines SET counter_idle_seconds = 30 WHERE code = 'pres-01' AND counter_idle_seconds = 120;

-- PLC konfigürasyonları (simülatör: host "simulator", makine başına ayrı port)
INSERT INTO dbo.machine_plc_configs (machine_id, edge_id, host, port, rack, slot, poll_ms, tags_json)
SELECT m.id, (SELECT id FROM dbo.edges WHERE code = 'edge-01'), 'simulator', v.port, 0, 1, 1000, v.tags_json
FROM (VALUES
    ('cnc-01', 10201, N'[
        {"name":"total_count","address":"DB1,DINT0","role":"total_count","unit":"pcs"},
        {"name":"scrap_count","address":"DB1,DINT4","role":"scrap_count","unit":"pcs"},
        {"name":"running","address":"DB1,X8.0","role":"running"},
        {"name":"state_code","address":"DB1,INT10","role":"state_code"},
        {"name":"spindle_temp","address":"DB1,REAL12","role":"process","unit":"°C"},
        {"name":"spindle_load","address":"DB1,REAL16","role":"process","unit":"%"}
    ]'),
    ('cnc-02', 10202, N'[
        {"name":"total_count","address":"DB1,DINT0","role":"total_count","unit":"pcs"},
        {"name":"running","address":"DB1,X8.0","role":"running"},
        {"name":"spindle_temp","address":"DB1,REAL12","role":"process","unit":"°C"},
        {"name":"spindle_load","address":"DB1,REAL16","role":"process","unit":"%"}
    ]'),
    ('pres-01', 10203, N'[
        {"name":"total_count","address":"DB1,DINT0","role":"total_count","unit":"pcs"},
        {"name":"scrap_count","address":"DB1,DINT4","role":"scrap_count","unit":"pcs"},
        {"name":"oil_pressure","address":"DB1,REAL12","role":"process","unit":"bar"},
        {"name":"tonnage","address":"DB1,REAL16","role":"process","unit":"t"}
    ]')
) v (code, port, tags_json)
JOIN dbo.machines m ON m.code = v.code
WHERE NOT EXISTS (SELECT 1 FROM dbo.machine_plc_configs c WHERE c.machine_id = m.id);

-- Ürünler ve ideal çevrim süreleri
INSERT INTO dbo.products (code, name)
SELECT v.code, v.name FROM (VALUES
    ('mil-a100',  N'Mil A100'),
    ('flans-b20', N'Flanş B20'),
    ('braket-c5', N'Braket C5')
) v (code, name)
WHERE NOT EXISTS (SELECT 1 FROM dbo.products p WHERE p.code = v.code);

INSERT INTO dbo.product_machine_rates (product_id, machine_id, ideal_cycle_seconds)
SELECT p.id, m.id, v.cycle
FROM (VALUES
    ('mil-a100',  'cnc-01', 45.0),
    ('flans-b20', 'cnc-01', 60.0),
    ('mil-a100',  'cnc-02', 50.0),
    ('flans-b20', 'cnc-02', 40.0),
    ('braket-c5', 'pres-01', 2.5)
) v (product_code, machine_code, cycle)
JOIN dbo.products p ON p.code = v.product_code
JOIN dbo.machines m ON m.code = v.machine_code
WHERE NOT EXISTS (SELECT 1 FROM dbo.product_machine_rates r WHERE r.product_id = p.id AND r.machine_id = m.id);

-- Duruş nedenleri
INSERT INTO dbo.downtime_reasons (code, name, category, sort_order)
SELECT v.code, v.name, v.category, v.sort_order FROM (VALUES
    ('ARIZA-MEK',  N'Mekanik arıza',        'unplanned',  1),
    ('ARIZA-ELK',  N'Elektrik arızası',     'unplanned',  2),
    ('MALZEME',    N'Malzeme bekleme',      'unplanned',  3),
    ('OPERATOR',   N'Operatör yok',         'unplanned',  4),
    ('KALITE',     N'Kalite kontrol / ayar', 'unplanned', 5),
    ('TAKIM',      N'Takım değişimi',       'changeover', 6),
    ('URUN-DEG',   N'Ürün değişimi (setup)', 'changeover', 7),
    ('BAKIM-PLN',  N'Planlı bakım',         'planned',    8),
    ('MOLA',       N'Mola / yemek',         'planned',    9),
    ('TOPLANTI',   N'Toplantı / eğitim',    'planned',   10)
) v (code, name, category, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM dbo.downtime_reasons r WHERE r.code = v.code);

-- Vardiyalar (3 vardiya, Pazartesi–Cumartesi = 63)
INSERT INTO dbo.shift_definitions (name, start_local, end_local, days_mask)
SELECT v.name, v.s, v.e, 63 FROM (VALUES
    (N'Vardiya 1', CAST('08:00' AS time(0)), CAST('16:00' AS time(0))),
    (N'Vardiya 2', CAST('16:00' AS time(0)), CAST('00:00' AS time(0))),
    (N'Vardiya 3', CAST('00:00' AS time(0)), CAST('08:00' AS time(0)))
) v (name, s, e)
WHERE NOT EXISTS (SELECT 1 FROM dbo.shift_definitions s WHERE s.name = v.name);

INSERT INTO dbo.planned_stop_definitions (shift_definition_id, name, start_local, duration_minutes)
SELECT s.id, v.stop_name, v.start_local, v.duration
FROM (VALUES
    (N'Vardiya 1', N'Yemek', CAST('12:00' AS time(0)), 30),
    (N'Vardiya 2', N'Yemek', CAST('20:00' AS time(0)), 30),
    (N'Vardiya 3', N'Yemek', CAST('04:00' AS time(0)), 30)
) v (shift_name, stop_name, start_local, duration)
JOIN dbo.shift_definitions s ON s.name = v.shift_name
WHERE NOT EXISTS (SELECT 1 FROM dbo.planned_stop_definitions p WHERE p.shift_definition_id = s.id AND p.name = v.stop_name);
GO
