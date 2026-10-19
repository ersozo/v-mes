from conftest import unique


def test_product_and_rates(client, admin):
    p = client.post("/api/products", headers=admin, json={"code": unique("urun"), "name": "Ürün"}).json()
    machines = client.get("/api/machines", headers=admin).json()[:2]
    body = [{"machine_id": m["id"], "ideal_cycle_seconds": 12.5} for m in machines]
    r = client.put(f"/api/products/{p['id']}/rates", headers=admin, json=body)
    assert r.status_code == 200 and len(r.json()) == len(machines)
    assert float(r.json()[0]["ideal_cycle_seconds"]) == 12.5
    assert client.put(f"/api/products/{p['id']}/rates", headers=admin, json=body + body[:1]).status_code == 422
    assert client.put(f"/api/products/{p['id']}/rates", headers=admin, json=[{"machine_id": machines[0]["id"], "ideal_cycle_seconds": 0}]).status_code == 422


def test_night_shift_with_planned_stop(client, admin):
    r = client.post("/api/shifts", headers=admin, json={
        "name": unique("Gece"), "start_local": "22:00", "end_local": "06:00", "days_mask": 31,
        "planned_stops": [{"name": "Yemek", "start_local": "02:00", "duration_minutes": 30}],
    })
    assert r.status_code == 201, r.text
    s = r.json()
    assert s["start_local"] == "22:00:00" and s["planned_stops"][0]["start_local"] == "02:00:00"


def test_planned_stop_outside_shift_rejected(client, admin):
    r = client.post("/api/shifts", headers=admin, json={
        "name": unique("Gündüz"), "start_local": "08:00", "end_local": "16:00",
        "planned_stops": [{"name": "Geç mola", "start_local": "15:45", "duration_minutes": 30}],
    })
    assert r.status_code == 422


def test_replace_shift(client, admin):
    s = client.post("/api/shifts", headers=admin, json={"name": unique("V"), "start_local": "08:00", "end_local": "16:00"}).json()
    r = client.put(f"/api/shifts/{s['id']}", headers=admin, json={
        "name": s["name"], "start_local": "07:00", "end_local": "15:00",
        "planned_stops": [{"name": "Çay", "start_local": "10:00", "duration_minutes": 15}],
    })
    assert r.json()["start_local"] == "07:00:00" and len(r.json()["planned_stops"]) == 1


def test_downtime_reasons(client, admin):
    parent = client.post("/api/downtime-reasons", headers=admin, json={"code": unique("ARIZA")[:32], "name": "Arıza", "category": "unplanned"}).json()
    child = client.post("/api/downtime-reasons", headers=admin, json={"code": unique("HID")[:32], "name": "Hidrolik", "category": "unplanned", "parent_id": parent["id"]})
    assert child.status_code == 201
    assert client.patch(f"/api/downtime-reasons/{parent['id']}", headers=admin, json={"parent_id": parent["id"]}).status_code == 422
    assert client.post("/api/downtime-reasons", headers=admin, json={"code": "X1", "name": "x", "category": "bilinmeyen"}).status_code == 422


def test_settings(client, admin):
    assert client.patch("/api/settings", headers=admin, json={"timezone": "Mars/Olympus"}).status_code == 422
    r = client.patch("/api/settings", headers=admin, json={"timezone": "Europe/Istanbul", "min_downtime_seconds": 90})
    assert r.status_code == 200 and r.json()["min_downtime_seconds"] == 90
    client.patch("/api/settings", headers=admin, json={"min_downtime_seconds": 60})
