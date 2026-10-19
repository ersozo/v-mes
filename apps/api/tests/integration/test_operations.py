from datetime import UTC, datetime, timedelta

from conftest import make_line_and_machine, unique


def _product(client, admin, machine_id, cycle=30.0):
    p = client.post("/api/products", headers=admin, json={"code": unique("p"), "name": "Ürün"}).json()
    client.put(f"/api/products/{p['id']}/rates", headers=admin, json=[{"machine_id": machine_id, "ideal_cycle_seconds": cycle}])
    return p


def test_order_lifecycle_and_progress(client, admin, users, db):
    m = make_line_and_machine(client, admin, scrap_source="plc")
    p = _product(client, admin, m["id"])
    op = users["operator"]
    o = client.post("/api/production-orders", headers=op, json={"order_no": unique("IE"), "product_id": p["id"], "machine_id": m["id"], "target_qty": 100})
    assert o.status_code == 201 and o.json()["status"] == "planned"
    oid = o.json()["id"]

    started = client.post(f"/api/production-orders/{oid}/start", headers=op).json()
    assert started["status"] == "running" and started["started_at"]

    # Aynı makinede ikinci iş emri başlatılamaz
    o2 = client.post("/api/production-orders", headers=op, json={"order_no": unique("IE"), "product_id": p["id"], "machine_id": m["id"], "target_qty": 5}).json()
    r = client.post(f"/api/production-orders/{o2['id']}/start", headers=op)
    assert r.status_code == 409 and started["order_no"] in r.json()["detail"]

    # Çalışma aralığına üretim yaz (geçmiş bir dakika kovası, run başlangıcından sonra)
    with db.cursor() as cur:
        cur.execute("UPDATE dbo.production_order_runs SET start_ts = DATEADD(minute, -10, start_ts) WHERE production_order_id = %s", (oid,))
        cur.execute("""INSERT INTO dbo.counter_deltas_1m (machine_id, bucket_ts, role, delta) VALUES
                       (%s, DATEADD(minute, -5, CAST(SYSUTCDATETIME() AS datetime2(0))), 'total_count', 40),
                       (%s, DATEADD(minute, -5, CAST(SYSUTCDATETIME() AS datetime2(0))), 'scrap_count', 4)""", (m["id"], m["id"]))
    db.commit()
    got = client.get(f"/api/production-orders/{oid}", headers=op).json()
    assert (got["produced_qty"], got["scrap_qty"], got["good_qty"]) == (40, 4, 36)
    assert got["progress"] == 0.36 and got["remaining_ideal_seconds"] == 64 * 30

    assert client.post(f"/api/production-orders/{oid}/pause", headers=op).json()["status"] == "paused"
    assert client.patch(f"/api/production-orders/{oid}", headers=op, json={"product_id": p["id"]}).status_code == 409
    assert client.post(f"/api/production-orders/{oid}/start", headers=op).json()["status"] == "running"
    done = client.post(f"/api/production-orders/{oid}/complete", headers=op).json()
    assert done["status"] == "done" and done["ended_at"]
    assert len(client.get(f"/api/production-orders/{oid}", headers=op).json()["runs"]) == 2
    assert client.post(f"/api/production-orders/{oid}/cancel", headers=op).status_code == 409
    assert client.post("/api/production-orders", headers=users["viewer"], json={"order_no": unique("IE"), "product_id": p["id"], "machine_id": m["id"], "target_qty": 1}).status_code == 403


def test_assign_downtime_reason(client, admin, users, db):
    m = make_line_and_machine(client, admin)
    with db.cursor() as cur:
        cur.execute("INSERT INTO dbo.downtime_logs (machine_id, start_ts, end_ts) OUTPUT inserted.id VALUES (%s, DATEADD(hour, -1, SYSUTCDATETIME()), DATEADD(minute, -50, SYSUTCDATETIME()))", (m["id"],))
        did = cur.fetchone()["id"]
    db.commit()
    unassigned = client.get(f"/api/downtimes?machine_id={m['id']}&unassigned=true", headers=users["viewer"]).json()
    assert [d["id"] for d in unassigned] == [did] and unassigned[0]["category"] == "unassigned"
    assert 590 <= unassigned[0]["duration_seconds"] <= 610

    reasons = client.get("/api/downtime-reasons", headers=admin).json()
    reason = next(r for r in reasons if r["code"] == "MALZEME")
    assert client.patch(f"/api/downtimes/{did}", headers=users["viewer"], json={"reason_id": reason["id"]}).status_code == 403
    r = client.patch(f"/api/downtimes/{did}", headers=users["operator"], json={"reason_id": reason["id"], "note": "Bobin bitti"})
    assert r.status_code == 200
    assert r.json()["reason_code"] == "MALZEME" and r.json()["assigned_by"].startswith("operator") and r.json()["note"] == "Bobin bitti"
    assert client.get(f"/api/downtimes?machine_id={m['id']}&unassigned=true", headers=admin).json() == []

    inactive = client.post("/api/downtime-reasons", headers=admin, json={"code": unique("ESKI")[:32], "name": "Eski", "category": "unplanned", "is_active": False}).json()
    assert client.patch(f"/api/downtimes/{did}", headers=admin, json={"reason_id": inactive["id"]}).status_code == 422


def test_manual_scrap_links_running_order(client, admin, users):
    m = make_line_and_machine(client, admin, scrap_source="manual")
    p = _product(client, admin, m["id"])
    o = client.post("/api/production-orders", headers=admin, json={"order_no": unique("IE"), "product_id": p["id"], "machine_id": m["id"], "target_qty": 10}).json()
    client.post(f"/api/production-orders/{o['id']}/start", headers=admin)
    s = client.post("/api/scrap", headers=users["operator"], json={"machine_id": m["id"], "qty": 3, "reason": "Çapak"})
    assert s.status_code == 201 and s.json()["production_order_id"] == o["id"]
    assert client.get(f"/api/production-orders/{o['id']}", headers=admin).json()["scrap_qty"] == 0  # üretim yok → hurda üretimle sınırlı
    old = (datetime.now(UTC).replace(tzinfo=None) - timedelta(days=30)).isoformat()
    assert client.post("/api/scrap", headers=admin, json={"machine_id": m["id"], "qty": 1, "ts": old}).status_code == 422
    view = client.get(f"/api/operator/machines/{m['id']}", headers=users["operator"]).json()
    assert view["active_order"]["id"] == o["id"]
