import pytest

from mes_api.settings import flow_mqtt_options

KEYS = ["FLOW_MQTT_MODE", "FLOW_MQTT_HOST", "FLOW_MQTT_PORT", "FLOW_MQTT_USER", "FLOW_MQTT_PASSWORD", "FLOW_MQTT_CA_FILE", "FLOW_MQTT_TLS"]


def test_empty_compose_values_mean_defaults(monkeypatch):
    # docker compose, ${X:-} ile tanımsız değişkenleri boş metin olarak geçirir
    for k in KEYS:
        monkeypatch.setenv(k, "")
    o = flow_mqtt_options()
    assert (o.mode, o.port, o.tls) == ("env", 1883, False)


def test_inline_from_env(monkeypatch):
    for k, v in {"FLOW_MQTT_MODE": "inline", "FLOW_MQTT_HOST": "10.146.0.50", "FLOW_MQTT_USER": "nodered",
                 "FLOW_MQTT_PASSWORD": "x", "FLOW_MQTT_PORT": "", "FLOW_MQTT_TLS": "true", "FLOW_MQTT_CA_FILE": "/data/ca.crt"}.items():
        monkeypatch.setenv(k, v)
    o = flow_mqtt_options()
    assert (o.mode, o.host, o.port, o.tls, o.ca_file) == ("inline", "10.146.0.50", 8883, True, "/data/ca.crt")


def test_inline_missing_values_fail_fast(monkeypatch):
    for k in KEYS:
        monkeypatch.setenv(k, "")
    monkeypatch.setenv("FLOW_MQTT_MODE", "inline")
    with pytest.raises(ValueError, match="FLOW_MQTT_HOST"):
        flow_mqtt_options()
