import { z } from "zod";

const schema = z.object({
  MQTT_URL: z.string().default("mqtt://emqx:1883"),
  MQTT_USER: z.string().min(1),
  MQTT_PASSWORD: z.string().min(1),
  MQTT_CLIENT_ID: z.string().default("vmes-ingestion"),

  MSSQL_HOST: z.string().default("mssql"),
  MSSQL_PORT: z.coerce.number().int().default(1433),
  MSSQL_DB: z.string().default("MES_DB"),
  MSSQL_APP_USER: z.string().min(1),
  MSSQL_APP_PASSWORD: z.string().min(1),

  /** API ile paylaşılan JWT imza anahtarı (HS256). */
  JWT_SECRET: z.string().min(32, "JWT_SECRET en az 32 karakter olmalı"),
  HTTP_PORT: z.coerce.number().int().default(3001),
  CORS_ORIGIN: z.string().default("*"),

  FLUSH_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  FLUSH_MAX_ROWS: z.coerce.number().int().min(100).default(5000),
  /** DB erişilemezken bellekte tutulacak en fazla telemetri satırı; aşılırsa en eskiler atılır. */
  BUFFER_MAX_ROWS: z.coerce.number().int().min(1000).default(500_000),
  REGISTRY_REFRESH_MS: z.coerce.number().int().min(1000).default(30_000),
  /** Tek örnekte kabul edilen en büyük sayaç artışı; üstü anomali sayılır. */
  COUNTER_MAX_DELTA: z.coerce.number().int().min(1).default(10_000),
  /** Bu kadar ileri tarihli zaman damgaları reddedilir (saat hatası). */
  MAX_CLOCK_SKEW_MS: z.coerce.number().int().default(5 * 60_000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Geçersiz yapılandırma:\n${issues}`);
  }
  return result.data;
}
