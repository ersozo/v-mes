"""Akış üretici komut satırı aracı (3. aşamada REST uç noktalarıyla da sunulacak).

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
from mes_api.settings import NodeRedSettings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["preview", "deploy", "dump"])
    parser.add_argument("--edge-id", default=os.environ.get("EDGE_ID", "edge-01"))
    args = parser.parse_args()

    with connect() as conn:
        lines = load_line_specs(conn)
    managed = build_managed_flows(lines, args.edge_id)

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


if __name__ == "__main__":
    sys.exit(main())
