// MQTT payload sözleşmeleri (Node-RED → EMQX → Ingestion).

import { z } from "zod";
import { slugSchema } from "./topics.js";
import { TAG_NAME_PATTERN } from "./plc.js";

export const PAYLOAD_VERSION = 1;

/** UTC ISO-8601 zaman damgası; saat dilimi ofseti yerine "Z" zorunlu. */
export const utcTimestampSchema = z.iso.datetime({ offset: false });

/** Tag değeri: sonlu sayı veya boolean (boolean veritabanına 0/1 olarak yazılır). */
export const tagValueSchema = z.union([z.number().refine(Number.isFinite, "sonlu bir sayı olmalı"), z.boolean()]);

export const telemetryPayloadSchema = z.object({
  v: z.literal(PAYLOAD_VERSION),
  machine_code: slugSchema,
  ts: utcTimestampSchema,
  tags: z
    .record(z.string().regex(TAG_NAME_PATTERN, "geçersiz tag adı"), tagValueSchema)
    .refine((tags) => Object.keys(tags).length > 0, "en az bir tag içermeli")
    .refine((tags) => Object.keys(tags).length <= 256, "en fazla 256 tag"),
});
export type TelemetryPayload = z.infer<typeof telemetryPayloadSchema>;

export const statusPayloadSchema = z.object({
  v: z.literal(PAYLOAD_VERSION),
  machine_code: slugSchema,
  ts: utcTimestampSchema,
  online: z.boolean(),
  error: z.string().max(500).optional(),
});
export type StatusPayload = z.infer<typeof statusPayloadSchema>;

export const heartbeatPayloadSchema = z.object({
  v: z.literal(PAYLOAD_VERSION),
  edge_id: slugSchema,
  ts: utcTimestampSchema,
});
export type HeartbeatPayload = z.infer<typeof heartbeatPayloadSchema>;

/** Boolean tag değerlerini 0/1'e çevirir (veritabanındaki float kolonu için). */
export function tagValueToNumber(value: number | boolean): number {
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}
