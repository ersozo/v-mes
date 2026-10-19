import { describe, expect, it } from "vitest";
import { heartbeatTopic, parseTopic, SUBSCRIPTIONS, telemetryTopic } from "../src/index.js";

describe("UNS topic'leri", () => {
  const path = { area: "talasli-imalat", line: "hat-1", machine: "cnc-01" };

  it("telemetri topic'i üretir ve geri çözümler", () => {
    const t = telemetryTopic(path);
    expect(t).toBe("factory/talasli-imalat/hat-1/cnc-01/telemetry");
    expect(parseTopic(t)).toEqual({ kind: "telemetry", ...path });
  });

  it("status ve heartbeat topic'lerini çözümler", () => {
    expect(parseTopic("factory/a/b/c/status")).toEqual({ kind: "status", area: "a", line: "b", machine: "c" });
    expect(parseTopic(heartbeatTopic("edge-01"))).toEqual({ kind: "heartbeat", edgeId: "edge-01" });
  });

  it.each([
    "factory/a/b/telemetry",
    "factory/a/b/c/d/telemetry",
    "factory/A/b/c/telemetry",
    "factory/a b/b/c/telemetry",
    "factory/a/b/c/other",
    "plant/a/b/c/telemetry",
    "factory/_edge/Edge/heartbeat",
    "factory/-a/b/c/telemetry",
  ])("geçersiz topic'i reddeder: %s", (topic) => {
    expect(parseTopic(topic)).toBeNull();
  });

  it("geçersiz slug ile topic üretmez", () => {
    expect(() => telemetryTopic({ ...path, machine: "CNC 01" })).toThrow();
  });

  it("abonelik kalıpları beklenen biçimde", () => {
    expect(SUBSCRIPTIONS.telemetry).toBe("factory/+/+/+/telemetry");
    expect(SUBSCRIPTIONS.heartbeat).toBe("factory/_edge/+/heartbeat");
  });
});
