"""Akış üretici komut satırı aracı (3. aşamada REST uç noktalarıyla da sunulacak).

    python -m mes_api.flows.cli check     # edge'deki Node-RED'i inceler (salt okunur): sürüm, S7 paketi, sekmeler
    python -m mes_api.flows.cli preview   # farkı ve üretilecek JSON özetini gösterir
    python -m mes_api.flows.cli deploy    # değişen hatları Node-RED'e deploy eder
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from mes_api.db import connect
from mes_api.flows.generator import build_managed_flows, diff_managed, merge_into_existing
from mes_api.flows.nodered import NodeRedAdmin
from mes_api.flows.repository import load_line_specs
from mes_api.settings import NodeRedSettings, flow_mqtt_options


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["check", "preview", "deploy", "dump"])
    parser.add_argument("--edge-id", default=os.environ.get("EDGE_ID", "edge-01"))
    args = parser.parse_args()

    if args.command == "check":
        return check()

    with connect() as conn:
        lines = load_line_specs(conn)
    managed = build_managed_flows(lines, args.edge_id, flow_mqtt_options())

    if args.command == "dump":
        json.dump(managed, sys.stdout, indent=2, ensure_ascii=False)
        print()
        return 0

    with NodeRedAdmin(NodeRedSettings.from_env()) as nr:
        existing, rev = nr.get_flows()
        diff = diff_managed(existing, managed)
        print(json.dumps({"edge_id": args.edge_id, "rev": rev, "diff": diff.as_dict()}, indent=2, ensure_ascii=False))
        if args.command == "deploy":
            if not diff.has_changes:
                print("Değişiklik yok; deploy atlandı.")
                return 0
            new_rev = nr.deploy_flows(merge_into_existing(existing, managed), rev)
            print(f"Deploy tamamlandı. Yeni rev: {new_rev}")
    return 0


SUPPORTED_S7 = ("3.",)   # akış üreticinin doğrulandığı node-red-contrib-s7 ana sürümleri


def check() -> int:
    """Edge Node-RED uyumluluk kontrolü — hiçbir şey değiştirmez."""
    s = NodeRedSettings.from_env()
    ok = True

    def line(mark: str, text: str) -> None:
        print(f"{mark} {text}")

    print(f"Node-RED: {s.url}")
    try:
        with NodeRedAdmin(s) as nr:
            auth = nr.auth_required()
            line("✓", f"Admin API erişilebilir; kimlik doğrulama {'açık' if auth else 'KAPALI (önerilmez)'}")
            settings = nr.get_settings()
            version = settings.get("version", "?")
            line("✓" if version.split(".")[0] in ("3", "4", "5") else "!", f"Node-RED sürümü {version}")
            nodes = nr.get_nodes()
            s7 = next((n for n in nodes if n.get("module") == "node-red-contrib-s7"), None)
            if s7 is None:
                ok = False
                line("✗", "node-red-contrib-s7 yüklü değil (Palette → Install)")
            else:
                supported = s7["version"].startswith(SUPPORTED_S7)
                ok &= supported
                line("✓" if supported else "!", f"node-red-contrib-s7 {s7['version']}"
                     + ("" if supported else " — akış üretici 3.x ile doğrulandı; uyumluluğu test edin"))
                if not s7.get("enabled", True):
                    ok = False
                    line("✗", "node-red-contrib-s7 devre dışı")
            mqtt = any(n.get("module") == "node-red" and "mqtt out" in n.get("types", []) for n in nodes)
            line("✓" if mqtt else "✗", "MQTT düğümleri (çekirdek)")
            ok &= mqtt
            flows, rev = nr.get_flows()
            tabs = [f for f in flows if f.get("type") == "tab"]
            managed = [t for t in tabs if str(t["id"]).startswith("mes-")]
            line("✓", f"{len(tabs)} sekme ({len(managed)} tanesi MES tarafından yönetiliyor, diğerlerine dokunulmaz)")
            for t in tabs:
                print(f"    {'[MES] ' if t in managed else '      '}{t.get('label', t['id'])}")
            endpoints = [n for n in flows if n.get("type") == "s7 endpoint" and not str(n.get("z", "")).startswith("mes-")]
            for e in endpoints:
                print(f"    mevcut S7 bağlantısı: {e.get('address')}:{e.get('port')} rack/slot {e.get('rack')}/{e.get('slot')} "
                      f"döngü {e.get('cycletime')} ms, {len(e.get('vartable', []))} değişken")
    except Exception as exc:
        line("✗", f"{exc}")
        return 1
    try:
        opts = flow_mqtt_options()
        target = f"{opts.host}:{opts.port}" if opts.mode == "inline" else f"${{MQTT_HOST}}:{opts.port}"
        line("✓", f"Akışlar MQTT'ye {target} adresinden bağlanacak (mod: {opts.mode}, TLS: {'açık' if opts.tls else 'kapalı'})")
    except ValueError as exc:
        ok = False
        line("✗", f"MQTT ayarı: {exc}")
    print("Sonuç:", "uyumlu" if ok else "sorunları giderin")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
