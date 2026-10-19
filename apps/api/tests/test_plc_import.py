"""TIA DB içe aktarma — kullanıcının mekanik.xlsx dosyasıyla aynı yapıda sentetik veri."""

import io

from openpyxl import Workbook

from mes_api.plc import TagDefinition
from mes_api.plc_import import parse_rows, read_text, read_xlsx, suggest_name

# mekanik.xlsx düzeni: A boş, B ad, C tip, D ofset; ilk satırda DB adı
MEKANIK = [
    [None, "db200", None, "db200.0"],
    [None, "Static", None, "offset"],
    [None, "MODEL_ADI", "String", "16.0"],
    [None, "MakinaIstasyonData", "Array[1..30] of Struct", "892.0"],
    [None, "MakinaIstasyonData[1]", "Struct", "892.0"],
    [None, "girisSensoru", "Bool", "892.0"],
    [None, "cikisSensoru", "Bool", "892.1"],
    [None, "kosuBiti", None, "892.2"],
    [None, "sonsuzSayici", "UInt", "896.0"],
    [None, "MakinaIstasyonData[2]", "Struct", "902.0"],
    [None, "girisSensoru", "Bool", "902.0"],
    [None, "cikisSensoru", "Bool", "902.1"],
    [None, "kosuBiti", None, "902.2"],
    [None, "sonsuzSayici", "UInt", "906.0"],
]


def test_mekanik_layout():
    r = parse_rows(MEKANIK)
    assert r["db_number"] == 200
    by_path = {x["path"]: x for x in r["rows"]}
    assert by_path["MakinaIstasyonData[1].girisSensoru"]["address"] == "DB200,X892.0"
    assert by_path["MakinaIstasyonData[1].cikisSensoru"]["address"] == "DB200,X892.1"
    kosu = by_path["MakinaIstasyonData[2].kosuBiti"]
    assert kosu["address"] == "DB200,X902.2" and "Bool varsayıldı" in kosu["note"] and kosu["suggested_role"] == "running_candidate"
    sayac = by_path["MakinaIstasyonData[2].sonsuzSayici"]
    assert sayac["address"] == "DB200,WORD906" and sayac["suggested_role"] == "total_count_candidate"
    model = by_path["MODEL_ADI"]
    assert not model["supported"] and "String" in model["note"]
    assert sayac["name"] == "makina_istasyon_data_2_sonsuz_sayici"
    # Önerilen adresler sistemin kendi doğrulamasından geçer (UInt sayaç → WORD, toplam sayaç rolüne uygun)
    TagDefinition(name=sayac["name"], address=sayac["address"], role="total_count")
    TagDefinition(name=kosu["name"], address=kosu["address"], role="running")
    assert len([x for x in r["rows"] if x["supported"]]) == 8


def test_xlsx_roundtrip_and_db_override():
    wb = Workbook()
    for row in MEKANIK:
        wb.active.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    r = parse_rows(read_xlsx(buf.getvalue()), db_number=300)
    assert r["db_number"] == 300
    assert {x["address"] for x in r["rows"] if x["supported"]} >= {"DB300,X892.0", "DB300,WORD896"}


def test_pasted_tia_db_editor_rows():
    # DB editöründen kopyalanan satırlar: Ad, Tip, Ofset, Başlangıç değeri, ...
    text = "Name\tData type\tOffset\tStart value\nToplamAdet\tDInt\t0.0\t0\nHurdaAdet\tDInt\t4.0\t0\nCalisiyor\tBool\t8.0\tfalse\nSicaklik\tReal\t10.0\t0.0\nBaslangic\tDTL\t14.0\t\n"
    r = parse_rows(read_text(text), db_number=10)
    by = {x["path"]: x for x in r["rows"]}
    assert by["ToplamAdet"]["address"] == "DB10,DINT0" and by["ToplamAdet"]["suggested_role"] == "total_count_candidate"
    assert by["HurdaAdet"]["suggested_role"] == "scrap_count_candidate"
    assert by["Calisiyor"]["address"] == "DB10,X8.0" and by["Calisiyor"]["suggested_role"] == "running_candidate"
    assert by["Sicaklik"]["address"] == "DB10,REAL10"
    assert not by["Baslangic"]["supported"]


def test_missing_db_number_and_optimized_db():
    r = parse_rows([["Sayac", "DInt", "0.0"]])
    assert r["db_number"] is None and not r["rows"][0]["supported"]
    r2 = parse_rows([["Sayac", "DInt"], ["Motor", "Bool"]])     # optimize DB: ofset yok
    assert r2["rows"] == [] and any("optimize" in w for w in r2["warnings"])


def test_role_suggestion_does_not_misfire():
    from mes_api.plc_import import _suggest_role

    assert _suggest_role("ReduktorSicaklik", "DINT") == "process"
    assert _suggest_role("NOK_Adet", "DINT") == "scrap_count_candidate"
    assert _suggest_role("kosuBiti", "WORD") == "process"      # çalışıyor adayı yalnızca bit için


def test_suggest_name():
    assert suggest_name("MakinaIstasyonData[7].sonsuzSayici") == "makina_istasyon_data_7_sonsuz_sayici"
    assert suggest_name("Çıkış Sensörü") == "cikis_sensoru"
    assert suggest_name("1.Istasyon") == "t_1_istasyon"
