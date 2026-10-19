// Sözleşmeleri JSON Schema olarak dışa aktarır (Python/Pydantic modelleri bunlardan üretilir).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  heartbeatPayloadSchema,
  machinePlcConfigSchema,
  statusPayloadSchema,
  tagDefinitionSchema,
  telemetryPayloadSchema,
} from "../src/index.js";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "json-schema");
mkdirSync(outDir, { recursive: true });

const schemas = {
  TelemetryPayload: telemetryPayloadSchema,
  StatusPayload: statusPayloadSchema,
  HeartbeatPayload: heartbeatPayloadSchema,
  TagDefinition: tagDefinitionSchema,
  MachinePlcConfig: machinePlcConfigSchema,
};

for (const [name, schema] of Object.entries(schemas)) {
  // superRefine kuralları JSON Schema'ya taşınamaz; o kurallar API tarafında ayrıca doğrulanır.
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" });
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify({ title: name, ...json }, null, 2) + "\n");
  console.log(`json-schema: ${name}.json`);
}
