"""Kayıtlı makinelerden Node-RED akışı üretir.

Çıktı, Node-RED'in düz akış listesi biçimindedir (sekmeler + düğümler). Yönetilen tüm
öğelerin ID'leri deterministiktir; aynı girdi her zaman aynı JSON'ı üretir. Böylece
``Node-RED-Deployment-Type: flows`` ile deploy edildiğinde yalnızca değişen hatların
sekmeleri yeniden başlar.

Yönetilen sekmeler:
    mes-edge-{edge_id}   heartbeat
    mes-line-{line_id}   hattaki her makine için S7 okuma → normalize → MQTT
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

PAYLOAD_VERSION = 1
MANAGED_PREFIX = "mes-"
HEARTBEAT_SECONDS = 10

# MQTT bağlantı bilgileri Node-RED konteynerinin ortam değişkenlerinden okunur;
# böylece şifreler akış JSON'ına ve API'ye girmez.
MQTT_HOST_REF = "${MQTT_HOST}"
MQTT_CA_REF = "${MQTT_CA_FILE}"   # TLS açıkken Node-RED konteynerindeki CA dosyası yolu
MQTT_USER_REF = "${MQTT_USER}"
MQTT_PASSWORD_REF = "${MQTT_PASSWORD}"


@dataclass(frozen=True)
class TagSpec:
    name: str
    address: str


@dataclass(frozen=True)
class MachineSpec:
    code: str
    name: str
    host: str
    port: int
    rack: int
    slot: int
    poll_ms: int
    tags: tuple[TagSpec, ...]


@dataclass(frozen=True)
class LineSpec:
    id: int
    area_slug: str
    slug: str
    name: str
    edge_id: str
    machines: tuple[MachineSpec, ...] = field(default_factory=tuple)


def node_id(*parts: object) -> str:
    """Kararlı 16 haneli onaltılık düğüm ID'si (Node-RED biçimine uygun)."""
    return hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:16]


def line_tab_id(line_id: int) -> str:
    return f"{MANAGED_PREFIX}line-{line_id}"


def edge_tab_id(edge_id: str) -> str:
    return f"{MANAGED_PREFIX}edge-{edge_id}"


def is_managed(node: dict) -> bool:
    """Düğüm (veya sekme) MES tarafından mı yönetiliyor?"""
    return str(node.get("id", "")).startswith(MANAGED_PREFIX) or str(node.get("z", "")).startswith(MANAGED_PREFIX)


def _js(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


@dataclass(frozen=True)
class MqttOptions:
    """Edge'in broker'a bağlantısı. Edge sahada, broker merkezdeyse TLS (8883) kullanılır."""

    tls: bool = False
    port: int = 1883


def _tls_config(tab: str) -> dict:
    return {
        "id": node_id(tab, "tls"),
        "type": "tls-config",
        "z": tab,
        "name": "MES broker CA",
        "cert": "",
        "key": "",
        "ca": MQTT_CA_REF,
        "certname": "",
        "keyname": "",
        "caname": "",
        "servername": "",
        "verifyservercert": True,
        "alpnprotocol": "",
    }


def _broker(tab: str, client_id: str, label: str, mqtt: MqttOptions = MqttOptions()) -> list[dict]:
    nodes = [_tls_config(tab)] if mqtt.tls else []
    nodes.append({
        "id": node_id(tab, "broker"),
        "type": "mqtt-broker",
        "z": tab,
        "name": label,
        "broker": MQTT_HOST_REF,
        "port": str(mqtt.port),
        "clientid": client_id,
        "autoConnect": True,
        "usetls": mqtt.tls,
        **({"tls": node_id(tab, "tls")} if mqtt.tls else {}),
        "protocolVersion": "4",
        "keepalive": "30",
        "cleansession": True,
        "autoUnsubscribe": True,
        "birthTopic": "",
        "closeTopic": "",
        "willTopic": "",
        "credentials": {"user": MQTT_USER_REF, "password": MQTT_PASSWORD_REF},
    })
    return nodes


def _mqtt_out(tab: str, broker_id: str, y: int) -> dict:
    return {
        "id": node_id(tab, "mqtt-out"),
        "type": "mqtt out",
        "z": tab,
        "name": "EMQX",
        "topic": "",       # msg.topic kullanılır
        "qos": "1",
        "retain": "",      # msg.retain kullanılır (status mesajları retained)
        "broker": broker_id,
        "x": 900,
        "y": y,
        "wires": [],
    }


def _online_key(machine: MachineSpec) -> str:
    return f"online:{machine.code}"


def _normalize_func(machine: MachineSpec, topic: str, status_topic: str) -> str:
    return f"""// Otomatik üretildi — elle düzenlemeyin (MES akış üreticisi).
const tags = {{}};
for (const [k, v] of Object.entries(msg.payload || {{}})) {{
    if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") tags[k] = v;
}}
if (Object.keys(tags).length === 0) return null;
const ts = new Date().toISOString();
const out = [{{
    topic: {_js(topic)},
    qos: 1,
    retain: false,
    payload: {{ v: {PAYLOAD_VERSION}, machine_code: {_js(machine.code)}, ts, tags }},
}}];
// Veri okunabiliyorsa PLC çevrimiçidir. İlk okumada (veya kesinti sonrası) retained status yayınla:
// S7 düğümünün ilk durum olayı akış başlarken kaçabildiği için yalnızca status düğümüne güvenilmez.
if (flow.get({_js(_online_key(machine))}) !== true) {{
    flow.set({_js(_online_key(machine))}, true);
    out.push({{ topic: {_js(status_topic)}, qos: 1, retain: true,
        payload: {{ v: {PAYLOAD_VERSION}, machine_code: {_js(machine.code)}, ts, online: true }} }});
}}
return [out];
"""


def _status_func(machine: MachineSpec, topic: str) -> str:
    return f"""// Otomatik üretildi — S7 bağlantı durumunu retained status mesajına çevirir.
const s = msg.status || {{}};
let online;
if (s.fill === "green") online = true;
else if (s.fill === "red" || (s.fill === "yellow" && s.text !== "connecting")) online = false;
else return null;
if (flow.get({_js(_online_key(machine))}) === online) return null;
flow.set({_js(_online_key(machine))}, online);
const payload = {{ v: {PAYLOAD_VERSION}, machine_code: {_js(machine.code)}, ts: new Date().toISOString(), online }};
if (!online) payload.error = String(s.text || "offline");
return {{ topic: {_js(topic)}, qos: 1, retain: true, payload }};
"""


def _machine_nodes(tab: str, line: LineSpec, m: MachineSpec, row: int, mqtt_out_id: str) -> list[dict]:
    base = f"factory/{line.area_slug}/{line.slug}/{m.code}"
    y = 60 + row * 120
    endpoint_id = node_id(tab, m.code, "endpoint")
    s7in_id = node_id(tab, m.code, "s7in")
    norm_id = node_id(tab, m.code, "normalize")
    status_id = node_id(tab, m.code, "status")
    status_fn_id = node_id(tab, m.code, "status-fn")
    return [
        {
            "id": endpoint_id,
            "type": "s7 endpoint",
            "z": tab,
            "name": f"{m.code} @ {m.host}:{m.port}",
            "transport": "iso-on-tcp",
            "address": m.host,
            "port": str(m.port),
            "rack": str(m.rack),
            "slot": str(m.slot),
            "localtsaphi": "01",
            "localtsaplo": "00",
            "remotetsaphi": "01",
            "remotetsaplo": "00",
            "connmode": "rack-slot",
            "adapter": "",
            "busaddr": "2",
            "cycletime": str(m.poll_ms),
            "timeout": str(max(1500, min(m.poll_ms, 10000))),
            "vartable": [{"addr": t.address, "name": t.name} for t in m.tags],
        },
        {
            "id": s7in_id,
            "type": "s7 in",
            "z": tab,
            "name": m.name,
            "endpoint": endpoint_id,
            "mode": "all",
            "variable": "",
            # Her döngüde tüm değerler gönderilir (değişmese de): ingestion canlılığı
            # ve sayaç hareketsizliğini bu örneklerden çıkarır.
            "diff": False,
            "x": 160,
            "y": y,
            "wires": [[norm_id]],
        },
        {
            "id": norm_id,
            "type": "function",
            "z": tab,
            "name": f"{m.code} → telemetry",
            "func": _normalize_func(m, f"{base}/telemetry", f"{base}/status"),
            "outputs": 1,
            "timeout": 0,
            "noerr": 0,
            "initialize": "",
            "finalize": "",
            "libs": [],
            "x": 520,
            "y": y,
            "wires": [[mqtt_out_id]],
        },
        {
            "id": status_id,
            "type": "status",
            "z": tab,
            "name": f"{m.code} bağlantı",
            "scope": [s7in_id],
            "x": 160,
            "y": y + 50,
            "wires": [[status_fn_id]],
        },
        {
            "id": status_fn_id,
            "type": "function",
            "z": tab,
            "name": f"{m.code} → status",
            "func": _status_func(m, f"{base}/status"),
            "outputs": 1,
            "timeout": 0,
            "noerr": 0,
            "initialize": "",
            "finalize": "",
            "libs": [],
            "x": 520,
            "y": y + 50,
            "wires": [[mqtt_out_id]],
        },
    ]


def build_line_flow(line: LineSpec, mqtt: MqttOptions = MqttOptions()) -> list[dict]:
    tab = line_tab_id(line.id)
    broker_nodes = _broker(tab, f"vmes-{line.edge_id}-line-{line.id}", f"EMQX ({line.area_slug}/{line.slug})", mqtt)
    mqtt_out = _mqtt_out(tab, broker_nodes[-1]["id"], 60 + max(len(line.machines) - 1, 0) * 60)
    nodes: list[dict] = [
        {
            "id": tab,
            "type": "tab",
            "label": f"MES · {line.name}",
            "disabled": False,
            "info": f"Otomatik üretildi: {line.area_slug}/{line.slug}. Elle yapılan değişiklikler bir sonraki deploy'da silinir.",
            "env": [],
        },
        *broker_nodes,
        mqtt_out,
    ]
    for row, machine in enumerate(sorted(line.machines, key=lambda m: m.code)):
        nodes.extend(_machine_nodes(tab, line, machine, row, mqtt_out["id"]))
    return nodes


def build_edge_flow(edge_id: str, mqtt: MqttOptions = MqttOptions()) -> list[dict]:
    tab = edge_tab_id(edge_id)
    broker_nodes = _broker(tab, f"vmes-{edge_id}-edge", "EMQX (edge)", mqtt)
    mqtt_out = _mqtt_out(tab, broker_nodes[-1]["id"], 60)
    inject_id = node_id(tab, "heartbeat-inject")
    fn_id = node_id(tab, "heartbeat-fn")
    return [
        {
            "id": tab,
            "type": "tab",
            "label": f"MES · Edge {edge_id}",
            "disabled": False,
            "info": "Otomatik üretildi: edge canlılık sinyali (heartbeat).",
            "env": [],
        },
        *broker_nodes,
        mqtt_out,
        {
            "id": inject_id,
            "type": "inject",
            "z": tab,
            "name": f"her {HEARTBEAT_SECONDS} sn",
            "props": [],
            "repeat": str(HEARTBEAT_SECONDS),
            "crontab": "",
            "once": True,
            "onceDelay": "1",
            "topic": "",
            "x": 160,
            "y": 60,
            "wires": [[fn_id]],
        },
        {
            "id": fn_id,
            "type": "function",
            "z": tab,
            "name": "heartbeat",
            "func": (
                "// Otomatik üretildi.\n"
                f"return {{ topic: {_js(f'factory/_edge/{edge_id}/heartbeat')}, qos: 0, retain: false, "
                f"payload: {{ v: {PAYLOAD_VERSION}, edge_id: {_js(edge_id)}, ts: new Date().toISOString() }} }};\n"
            ),
            "outputs": 1,
            "timeout": 0,
            "noerr": 0,
            "initialize": "",
            "finalize": "",
            "libs": [],
            "x": 520,
            "y": 60,
            "wires": [[mqtt_out["id"]]],
        },
    ]


def build_managed_flows(lines: list[LineSpec], edge_id: str, mqtt: MqttOptions = MqttOptions()) -> list[dict]:
    """Belirli bir edge'in yönettiği tüm sekmeler ve düğümler (yalnızca makinesi olan hatlar)."""
    nodes = build_edge_flow(edge_id, mqtt)
    for line in sorted(lines, key=lambda l: l.id):
        if line.edge_id == edge_id and line.machines:
            nodes.extend(build_line_flow(line, mqtt))
    return nodes


def _tab_of(node: dict) -> str:
    return node["id"] if node.get("type") == "tab" else node.get("z", "")


def merge_into_existing(existing: list[dict], managed: list[dict]) -> list[dict]:
    """Mevcut akıştan yönetilen öğeleri çıkarıp yenilerini ekler; kullanıcının sekmelerine dokunmaz.

    İçeriği değişmeyen yönetilen sekmeler için Node-RED'in mevcut düğümleri aynen geri gönderilir.
    Yeni düğümler credentials içerdiğinden, aynı değerlerle bile gönderilse Node-RED onları
    "değişmiş" sayar ve o sekmenin MQTT bağlantısını yeniden kurar.
    """
    unchanged = set(diff_managed(existing, managed).unchanged_tabs)
    kept = [n for n in existing if not is_managed(n) or _tab_of(n) in unchanged]
    return kept + [n for n in managed if _tab_of(n) not in unchanged]


@dataclass(frozen=True)
class FlowDiff:
    added_tabs: list[str]
    removed_tabs: list[str]
    changed_tabs: list[str]
    unchanged_tabs: list[str]

    @property
    def has_changes(self) -> bool:
        return bool(self.added_tabs or self.removed_tabs or self.changed_tabs)

    def as_dict(self) -> dict:
        return {
            "added": self.added_tabs,
            "removed": self.removed_tabs,
            "changed": self.changed_tabs,
            "unchanged": self.unchanged_tabs,
        }


def _normalize_for_compare(node: dict) -> dict:
    # Node-RED GET /flows credentials döndürmez; karşılaştırmada yok sayılır.
    return {k: v for k, v in node.items() if k != "credentials"}


def diff_managed(existing: list[dict], managed: list[dict]) -> FlowDiff:
    def by_tab(nodes: list[dict]) -> dict[str, list[dict]]:
        tabs: dict[str, list[dict]] = {}
        for n in nodes:
            if not is_managed(n):
                continue
            tabs.setdefault(_tab_of(n), []).append(_normalize_for_compare(n))
        return {t: sorted(ns, key=lambda n: n["id"]) for t, ns in tabs.items()}

    old, new = by_tab(existing), by_tab(managed)
    return FlowDiff(
        added_tabs=sorted(set(new) - set(old)),
        removed_tabs=sorted(set(old) - set(new)),
        changed_tabs=sorted(t for t in set(new) & set(old) if old[t] != new[t]),
        unchanged_tabs=sorted(t for t in set(new) & set(old) if old[t] == new[t]),
    )
