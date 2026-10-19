"""Akış komut satırı aracı (arayüzdeki PLC konfigüratörü → Edge'ler / Dağıt ile aynı işlemler).

    python -m mes_api.flows.cli check   [--edge KOD]   # edge Node-RED'lerini incele (salt okunur)
    python -m mes_api.flows.cli preview [--edge KOD]   # edge başına farkı göster
    python -m mes_api.flows.cli deploy  [--edge KOD]   # değişen edge'leri dağıt
    python -m mes_api.flows.cli dump     --edge KOD    # üretilecek akış JSON'ı
"""

from __future__ import annotations

import argparse
import json
import sys

from mes_api.db import connect
from mes_api.flows import service
from mes_api.flows.generator import build_managed_flows
from mes_api.flows.repository import load_edges, load_line_specs
from mes_api.settings import flow_mqtt_options

MARK = {"ok": "✓", "warn": "!", "error": "✗"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["check", "preview", "deploy", "dump"])
    parser.add_argument("--edge", help="yalnızca bu edge kodu")
    args = parser.parse_args()

    with connect() as conn:
        edges = [e for e in load_edges(conn) if not args.edge or e.code == args.edge]
        if not edges:
            print("Eşleşen aktif edge yok" + (f": {args.edge}" if args.edge else ""))
            return 1
        edge_id = edges[0].id if args.edge else None

        if args.command == "check":
            ok = True
            for e in edges:
                info = service.check_edge(e)
                print(f"\n[{e.code}] {e.name} — {e.nodered_url}")
                for item in info["items"]:
                    print(f"  {MARK[item['status']]} {item['text']}")
                for t in info.get("tabs", []):
                    print(f"      {'[MES] ' if t['managed'] else '      '}{t['label']}")
                for ep in info.get("existing_s7_endpoints", []):
                    print(f"      mevcut S7: {ep['address']}:{ep['port']} rack/slot {ep['rack']}/{ep['slot']}, {ep['variables']} değişken")
                ok &= info["ok"]
            print("\nSonuç:", "uyumlu" if ok else "sorunları giderin")
            return 0 if ok else 1

        if args.command == "dump":
            json.dump(build_managed_flows(load_line_specs(conn), edges[0].code, flow_mqtt_options()), sys.stdout, indent=2, ensure_ascii=False)
            print()
            return 0

        if args.command == "preview":
            for p in service.plan(conn, edge_id):
                print(json.dumps(p.as_dict(), indent=2, ensure_ascii=False))
            return 0

        results = service.deploy(conn, None, edge_id)
        for r in results:
            print(f"[{r['code']}] {r['status']}" + (f": {r.get('error')}" if r.get("error") else "") + (f" (rev {r['rev']})" if r.get("rev") else ""))
            if r["status"] == "unchanged":
                print("  Değişiklik yok; deploy atlandı.")
        return 0 if all(r["status"] in ("deployed", "unchanged") for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
