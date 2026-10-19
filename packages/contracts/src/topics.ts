// UNS (Unified Namespace) topic yardımcıları — ISA-95 hiyerarşisi.
//   factory/{area}/{line}/{machine}/telemetry
//   factory/{area}/{line}/{machine}/status
//   factory/_edge/{edge_id}/heartbeat

import { z } from "zod";

export const UNS_ROOT = "factory";
export const EDGE_SEGMENT = "_edge";

/** Alan, hat, makine ve edge kimlikleri için ortak kural: küçük harf, rakam, tire. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const slugSchema = z.string().regex(SLUG_PATTERN, "yalnızca küçük harf, rakam ve tire (başta/sonda tire olamaz), en fazla 64 karakter");

export const SUBSCRIPTIONS = {
  telemetry: `${UNS_ROOT}/+/+/+/telemetry`,
  status: `${UNS_ROOT}/+/+/+/status`,
  heartbeat: `${UNS_ROOT}/${EDGE_SEGMENT}/+/heartbeat`,
} as const;

export interface MachinePath {
  area: string;
  line: string;
  machine: string;
}

export type ParsedTopic =
  | ({ kind: "telemetry" | "status" } & MachinePath)
  | { kind: "heartbeat"; edgeId: string };

function assertSlug(value: string, label: string): void {
  if (!SLUG_PATTERN.test(value)) {
    throw new Error(`Geçersiz ${label}: "${value}"`);
  }
}

export function telemetryTopic(path: MachinePath): string {
  return machineTopic(path, "telemetry");
}

export function statusTopic(path: MachinePath): string {
  return machineTopic(path, "status");
}

export function heartbeatTopic(edgeId: string): string {
  assertSlug(edgeId, "edge kimliği");
  return `${UNS_ROOT}/${EDGE_SEGMENT}/${edgeId}/heartbeat`;
}

function machineTopic(path: MachinePath, leaf: "telemetry" | "status"): string {
  assertSlug(path.area, "alan");
  assertSlug(path.line, "hat");
  assertSlug(path.machine, "makine kodu");
  return `${UNS_ROOT}/${path.area}/${path.line}/${path.machine}/${leaf}`;
}

/** Topic'i çözümler; UNS kalıbına uymayan topic'ler için null döner. */
export function parseTopic(topic: string): ParsedTopic | null {
  const parts = topic.split("/");
  if (parts[0] !== UNS_ROOT) return null;

  if (parts.length === 4 && parts[1] === EDGE_SEGMENT && parts[3] === "heartbeat") {
    const edgeId = parts[2]!;
    return SLUG_PATTERN.test(edgeId) ? { kind: "heartbeat", edgeId } : null;
  }

  if (parts.length !== 5) return null;
  const [, area, line, machine, leaf] = parts as [string, string, string, string, string];
  if (leaf !== "telemetry" && leaf !== "status") return null;
  if (![area, line, machine].every((s) => SLUG_PATTERN.test(s))) return null;
  return { kind: leaf, area, line, machine };
}
