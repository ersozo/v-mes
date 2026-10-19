import json

from mes_api.flows.generator import (
    LineSpec,
    MachineSpec,
    TagSpec,
    build_managed_flows,
    diff_managed,
    edge_tab_id,
    line_tab_id,
    merge_into_existing,
)


def machine(code: str, poll_ms: int = 1000) -> MachineSpec:
    return MachineSpec(
        code=code, name=code.upper(), host="192.168.10.21", port=102, rack=0, slot=1, poll_ms=poll_ms,
        tags=(TagSpec("total_count", "DB1,DINT0"), TagSpec("running", "DB1,X8.0")),
    )


def line(line_id: int, *machines: MachineSpec, edge: str = "edge-01") -> LineSpec:
    return LineSpec(id=line_id, area_slug="talasli-imalat", slug=f"hat-{line_id}", name=f"Hat {line_id}",
                    edge_id=edge, machines=machines)


def by_type(nodes, t):
    return [n for n in nodes if n["type"] == t]


def test_deterministic_output():
    lines = [line(1, machine("cnc-01"), machine("cnc-02"))]
    assert json.dumps(build_managed_flows(lines, "edge-01")) == json.dumps(build_managed_flows(lines, "edge-01"))


def test_structure_per_machine_and_tab():
    nodes = build_managed_flows([line(1, machine("cnc-01"), machine("cnc-02"))], "edge-01")
    tabs = {n["id"] for n in by_type(nodes, "tab")}
    assert tabs == {edge_tab_id("edge-01"), line_tab_id(1)}
    assert len(by_type(nodes, "s7 endpoint")) == 2
    assert len(by_type(nodes, "s7 in")) == 2
    assert len(by_type(nodes, "mqtt-broker")) == 2  # edge + hat
    ids = [n["id"] for n in nodes]
    assert len(ids) == len(set(ids)), "ID çakışması"
    # Tüm düğümler bir yönetilen sekmeye ait
    assert all(n["type"] == "tab" or n["z"] in tabs for n in nodes)
    # Tüm bağlantılar var olan düğümlere gider
    for n in nodes:
        for out in n.get("wires", []):
            assert all(w in ids for w in out)


def test_endpoint_config_for_s7_1500():
    nodes = build_managed_flows([line(1, machine("cnc-01", poll_ms=500))], "edge-01")
    ep = by_type(nodes, "s7 endpoint")[0]
    assert ep["connmode"] == "rack-slot" and ep["rack"] == "0" and ep["slot"] == "1"
    assert ep["cycletime"] == "500"
    assert ep["vartable"] == [{"addr": "DB1,DINT0", "name": "total_count"}, {"addr": "DB1,X8.0", "name": "running"}]
    s7in = by_type(nodes, "s7 in")[0]
    assert s7in["mode"] == "all" and s7in["diff"] is False


def test_topics_embedded_in_functions():
    nodes = build_managed_flows([line(1, machine("cnc-01"))], "edge-01")
    funcs = " ".join(n["func"] for n in by_type(nodes, "function"))
    assert '"factory/talasli-imalat/hat-1/cnc-01/telemetry"' in funcs
    assert '"factory/talasli-imalat/hat-1/cnc-01/status"' in funcs
    assert '"factory/_edge/edge-01/heartbeat"' in funcs


def test_mqtt_credentials_come_from_env():
    nodes = build_managed_flows([line(1, machine("cnc-01"))], "edge-01")
    for b in by_type(nodes, "mqtt-broker"):
        assert b["broker"] == "${MQTT_HOST}"
        assert b["credentials"] == {"user": "${MQTT_USER}", "password": "${MQTT_PASSWORD}"}


def test_other_edges_and_empty_lines_are_excluded():
    lines = [line(1, machine("cnc-01")), line(2, machine("cnc-02"), edge="edge-02"), line(3)]
    tabs = {n["id"] for n in by_type(build_managed_flows(lines, "edge-01"), "tab")}
    assert tabs == {edge_tab_id("edge-01"), line_tab_id(1)}


def test_merge_keeps_user_flows_and_diff_detects_changes():
    user_tab = {"id": "abc", "type": "tab", "label": "Benim akışım"}
    user_node = {"id": "def", "type": "inject", "z": "abc", "wires": []}
    v1 = build_managed_flows([line(1, machine("cnc-01")), line(2, machine("pres-01"))], "edge-01")
    deployed = merge_into_existing([user_tab, user_node], v1)
    assert user_tab in deployed and user_node in deployed

    # Node-RED GET /flows credentials döndürmez
    as_returned = [{k: v for k, v in n.items() if k != "credentials"} for n in deployed]
    assert not diff_managed(as_returned, v1).has_changes

    v2 = build_managed_flows([line(1, machine("cnc-01", poll_ms=250)), line(3, machine("cnc-09"))], "edge-01")
    d = diff_managed(as_returned, v2)
    assert d.changed_tabs == [line_tab_id(1)]
    assert d.added_tabs == [line_tab_id(3)]
    assert d.removed_tabs == [line_tab_id(2)]
    assert d.unchanged_tabs == [edge_tab_id("edge-01")]

    redeployed = merge_into_existing(as_returned, v2)
    assert not any(n.get("z") == line_tab_id(2) or n["id"] == line_tab_id(2) for n in redeployed)
    assert user_tab in redeployed


def test_unchanged_tabs_reuse_existing_nodes_without_credentials():
    v1 = build_managed_flows([line(1, machine("cnc-01")), line(2, machine("pres-01"))], "edge-01")
    as_returned = [{k: v for k, v in n.items() if k != "credentials"} for n in v1]
    v2 = build_managed_flows([line(1, machine("cnc-01", poll_ms=250)), line(2, machine("pres-01"))], "edge-01")
    merged = merge_into_existing(as_returned, v2)
    brokers = {n["z"]: n for n in merged if n["type"] == "mqtt-broker"}
    # Değişen hat yeni düğümlerle (credentials dahil), değişmeyenler mevcut hâliyle gider
    assert "credentials" in brokers[line_tab_id(1)]
    assert "credentials" not in brokers[line_tab_id(2)]
    assert "credentials" not in brokers[edge_tab_id("edge-01")]
    assert len(merged) == len(v2)
