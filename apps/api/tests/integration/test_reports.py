"""OEE uçtan uca: birim testindeki elle hesaplanmış senaryo gerçek veritabanı üzerinden."""

from datetime import datetime

import pytest

from conftest import make_line_and_machine, unique

DAY = 12  # 2026-10-12 Pazartesi; yerel 08:00–16:00 = UTC 05:00–13:00


def utc(h, m=0):
    return datetime(2026, 10, DAY, h, m)


@pytest.fixture
def isolated_shift(client, admin, db):
    """Test süresince yalnızca bilinen tek vardiya aktif olsun."""
    with db.cursor() as cur:
        cur.execute("SELECT id FROM dbo.shift_definitions WHERE is_active = 1")
        active = [r["id"] for r in cur.fetchall()]
        cur.execute("UPDATE dbo.shift_definitions SET is_active = 0")
    db.commit()
    s = client.post("/api/shifts", headers=admin, json={"name": unique("Gündüz"), "start_local": "08:00", "end_local": "16:00",
                                                        "planned_stops": [{"name": "Yemek", "start_local": "12:00", "duration_minutes": 30}]}).json()
    client.patch("/api/settings", headers=admin, json={"timezone": "Europe/Istanbul"})
    yield s
    with db.cursor() as cur:
        cur.execute("DELETE FROM dbo.shift_definitions WHERE id = %s", (s["id"],))
        if active:
            cur.execute(f"UPDATE dbo.shift_definitions SET is_active = 1 WHERE id IN ({', '.join(map(str, active))})")
    db.commit()


@pytest.fixture
def scenario(client, admin, db, isolated_shift):
    m = make_line_and_machine(client, admin, scrap_source="plc")
    p = client.post("/api/products", headers=admin, json={"code": unique("p"), "name": "Ürün"}).json()
    client.put(f"/api/products/{p['id']}/rates", headers=admin, json=[{"machine_id": m["id"], "ideal_cycle_seconds": 30}])
    reasons = {r["code"]: r["id"] for r in client.get("/api/downtime-reasons", headers=admin).json()}
    mid = m["id"]
    with db.cursor() as cur:
        cur.execute("INSERT INTO dbo.machine_state_intervals (machine_id, state, start_ts, end_ts) VALUES (%s, 'running', %s, %s)", (mid, utc(5), utc(13)))
        for start, end, code in [(utc(6), utc(6, 30), "ARIZA-MEK"), (utc(7), utc(7, 20), None),
                                 (utc(8), utc(8, 10), "URUN-DEG"), (utc(10), utc(10, 30), "BAKIM-PLN")]:
            cur.execute("INSERT INTO dbo.downtime_logs (machine_id, start_ts, end_ts, reason_id) VALUES (%s, %s, %s, %s)",
                        (mid, start, end, reasons.get(code) if code else None))
        cur.execute("""INSERT INTO dbo.counter_deltas_1m (machine_id, bucket_ts, role, delta) VALUES
                       (%s, %s, 'total_count', 600), (%s, %s, 'total_count', 50), (%s, %s, 'scrap_count', 30)""",
                    (mid, utc(5, 30), mid, utc(9, 10), mid, utc(5, 31)))
        cur.execute("INSERT INTO dbo.production_orders (order_no, product_id, machine_id, target_qty, status) OUTPUT inserted.id VALUES (%s, %s, %s, 1000, 'done')",
                    (unique("IE"), p["id"], mid))
        oid = cur.fetchone()["id"]
        cur.execute("INSERT INTO dbo.production_order_runs (production_order_id, machine_id, start_ts, end_ts) VALUES (%s, %s, %s, %s)", (oid, mid, utc(5), utc(13)))
        for i in range(120):
            cur.execute("INSERT INTO dbo.machine_telemetry (machine_id, tag_name, ts, value) VALUES (%s, 'temp', DATEADD(second, %s, %s), %s)",
                        (mid, i * 30, utc(5), 40 + (i % 10)))
    db.commit()
    return m


WINDOW = "from=2026-10-11T21:00:00Z&to=2026-10-12T21:00:00Z"


def test_oee_matches_hand_calculation(client, users, scenario):
    r = client.get(f"/api/oee?scope=machine&id={scenario['id']}&{WINDOW}", headers=users["viewer"])
    assert r.status_code == 200, r.text
    s = r.json()["summary"]
    assert s["planned_seconds"] == 420 * 60 and s["run_seconds"] == 360 * 60
    assert s["availability"] == pytest.approx(360 / 420, abs=1e-4)
    assert s["performance"] == pytest.approx(300 / 360, abs=1e-4)
    assert s["quality"] == pytest.approx(0.95, abs=1e-4)
    assert s["oee"] == pytest.approx((360 / 420) * (300 / 360) * 0.95, abs=1e-4)
    assert (s["total_count"], s["off_plan_count"], s["scrap_count"]) == (600, 50, 30)
    assert s["losses"] == {"availability_seconds": 3600, "performance_seconds": 3600, "quality_seconds": 900, "fully_productive_seconds": 17100}


def test_line_scope_and_hourly_series(client, users, scenario):
    r = client.get(f"/api/oee?scope=line&id={scenario['line_id']}&{WINDOW}&group_by=hour&breakdown=machine", headers=users["viewer"]).json()
    assert r["summary"]["machine_count"] == 1
    assert len(r["series"]) == 24 and r["series"][8]["label"] == "2026-10-12 08:00"
    assert sum(p["total_count"] for p in r["series"]) == 600
    assert r["series"][8]["machines"][0]["code"] == scenario["code"]
    shift = client.get(f"/api/oee?scope=area&id={scenario['area_id']}&{WINDOW}&group_by=shift", headers=users["viewer"]).json()
    assert len(shift["series"]) == 1 and shift["series"][0]["oee"] == r["summary"]["oee"]


def test_downtime_pareto(client, users, scenario):
    r = client.get(f"/api/reports/downtime-pareto?scope=machine&id={scenario['id']}&{WINDOW}", headers=users["viewer"]).json()
    by_cat = {x["category"]: x["seconds"] for x in r["reasons"]}
    assert by_cat == {"unplanned": 1800, "planned": 1800, "unassigned": 1200, "changeover": 600}
    assert r["total_seconds"] == 5400 and r["reasons"][-1]["cumulative_share"] == 1.0
    assert any(x["name"] == "Nedeni atanmamış" for x in r["reasons"])


def test_state_timeline_production_and_telemetry(client, users, scenario):
    t = client.get(f"/api/reports/state-timeline?scope=machine&id={scenario['id']}&{WINDOW}", headers=users["viewer"]).json()
    assert t["machines"][0]["segments"] == [{"state": "running", "from": "2026-10-12T05:00:00Z", "to": "2026-10-12T13:00:00Z", "open": False}]
    assert len(t["machines"][0]["downtimes"]) == 4 and len(t["shifts"]) == 1

    p = client.get(f"/api/reports/production?scope=machine&id={scenario['id']}&{WINDOW}&group_by=day", headers=users["viewer"]).json()
    assert p["totals"] == {"total_count": 650, "scrap_count": 30, "good_count": 620}   # planlı süre filtresi yok

    tel = client.get(f"/api/telemetry?machine_id={scenario['id']}&tags=temp&from=2026-10-12T05:00:00Z&to=2026-10-12T06:00:00Z&max_points=12",
                     headers=users["viewer"]).json()
    assert tel["bucket_seconds"] == 300 and len(tel["series"]["temp"]) == 12
    assert sum(x["n"] for x in tel["series"]["temp"]) == 120


def test_csv_export(client, users, scenario):
    r = client.get(f"/api/reports/downtime-pareto?scope=machine&id={scenario['id']}&{WINDOW}&format=csv", headers=users["viewer"])
    assert r.headers["content-type"].startswith("text/csv")
    assert r.text.startswith("﻿reason_id;code;name") and "Nedeni atanmamış" in r.text
    o = client.get(f"/api/oee?scope=machine&id={scenario['id']}&{WINDOW}&group_by=hour&format=csv", headers=users["viewer"])
    assert o.text.count("\n") == 25


def test_window_validation_and_presets(client, users, isolated_shift):
    assert client.get("/api/oee?from=2026-10-12T00:00:00Z", headers=users["viewer"]).status_code == 422
    assert client.get("/api/oee?from=2026-10-12T00:00:00Z&to=2026-10-11T00:00:00Z", headers=users["viewer"]).status_code == 422
    assert client.get("/api/oee?preset=today&group_by=hour", headers=users["viewer"]).status_code == 200
    assert client.get("/api/oee?preset=bogus", headers=users["viewer"]).status_code == 422
    assert client.get("/api/oee?scope=machine&preset=today", headers=users["viewer"]).status_code == 422
    assert client.get("/api/oee/live", headers=users["viewer"]).status_code == 200
