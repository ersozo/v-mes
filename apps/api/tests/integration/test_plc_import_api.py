import io

from openpyxl import Workbook


def xlsx(rows) -> bytes:
    wb = Workbook()
    for r in rows:
        wb.active.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


ROWS = [[None, "db200"], [None, "MakinaIstasyonData[7]", "Struct", "952.0"], [None, "kosuBiti", None, "952.2"], [None, "sonsuzSayici", "UInt", "956.0"]]


def test_upload_xlsx(client, users):
    r = client.post("/api/plc/import", headers=users["engineer"],
                    files={"file": ("mekanik.xlsx", xlsx(ROWS), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["db_number"] == 200
    assert {x["address"] for x in body["rows"]} == {"DB200,X952.2", "DB200,WORD956"}


def test_paste_text_with_db_override(client, users):
    r = client.post("/api/plc/import", headers=users["admin"], data={"text": "ToplamAdet\tDInt\t0.0\nCalisiyor\tBool\t4.0", "db_number": "5"})
    assert [x["address"] for x in r.json()["rows"]] == ["DB5,DINT0", "DB5,X4.0"]


def test_validation_and_permissions(client, users):
    assert client.post("/api/plc/import", headers=users["admin"], data={}).status_code == 422
    assert client.post("/api/plc/import", headers=users["operator"], data={"text": "a\tDInt\t0.0"}).status_code == 403
    big = b"x" * (2 * 1024 * 1024 + 10)
    assert client.post("/api/plc/import", headers=users["admin"], files={"file": ("big.csv", big, "text/csv")}).status_code == 413
    assert client.post("/api/plc/import", headers=users["admin"], files={"file": ("bozuk.xlsx", b"PK\x03\x04bozuk", "application/octet-stream")}).status_code == 422
