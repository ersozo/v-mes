// Socket.io canlı yayın. Bağlantılar API'nin verdiği JWT ile doğrulanır.
//
// İstemci → sunucu:  "subscribe" / "unsubscribe"  { room: "plant" | "line:<id>" | "machine:<id>" }
// Sunucu → istemci:  "snapshot", "telemetry", "state", "downtime_opened", "downtime_closed", "edge"

import type { Server as HttpServer } from "node:http";
import { jwtVerify } from "jose";
import { Server } from "socket.io";
import type { Logger } from "./logger.js";

const ROOM_RE = /^(plant|line:\d+|machine:\d+)$/;
const ALLOWED_ROLES = new Set(["admin", "engineer", "operator", "viewer"]);

export interface MachineScope {
  machineId: number;
  lineId: number;
}

export class Realtime {
  readonly io: Server;
  private readonly latestTelemetry = new Map<number, unknown>();
  private readonly pendingTelemetry = new Map<number, { scope: MachineScope; payload: unknown }>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    http: HttpServer,
    jwtSecret: string,
    corsOrigin: string,
    private readonly snapshot: () => unknown,
    private readonly log: Logger,
  ) {
    const key = new TextEncoder().encode(jwtSecret);
    this.io = new Server(http, {
      cors: { origin: corsOrigin === "*" ? true : corsOrigin.split(","), credentials: true },
      serveClient: false,
    });

    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token;
        if (typeof token !== "string") throw new Error("token yok");
        const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
        if (payload.type !== "access" || !ALLOWED_ROLES.has(String(payload.role))) throw new Error("geçersiz token");
        socket.data.user = { id: payload.sub, role: payload.role };
        next();
      } catch {
        next(new Error("unauthorized"));
      }
    });

    this.io.on("connection", (socket) => {
      socket.on("subscribe", (msg: { room?: unknown }, ack?: (r: unknown) => void) => {
        const room = typeof msg?.room === "string" ? msg.room : "";
        if (!ROOM_RE.test(room)) return ack?.({ ok: false, error: "geçersiz oda" });
        void socket.join(room);
        ack?.({ ok: true });
      });
      socket.on("unsubscribe", (msg: { room?: unknown }) => {
        if (typeof msg?.room === "string") void socket.leave(msg.room);
      });
      socket.emit("snapshot", { ...(this.snapshot() as object), telemetry: Object.fromEntries(this.latestTelemetry) });
    });

    // Telemetri makine başına en fazla saniyede bir yayınlanır.
    this.timer = setInterval(() => this.flushTelemetry(), 1000);
    this.timer.unref();
  }

  private rooms(scope: MachineScope): string[] {
    return ["plant", `line:${scope.lineId}`, `machine:${scope.machineId}`];
  }

  telemetry(scope: MachineScope, payload: unknown): void {
    this.latestTelemetry.set(scope.machineId, payload);
    this.pendingTelemetry.set(scope.machineId, { scope, payload });
  }

  private flushTelemetry(): void {
    for (const { scope, payload } of this.pendingTelemetry.values()) {
      this.io.to(this.rooms(scope)).emit("telemetry", payload);
    }
    this.pendingTelemetry.clear();
  }

  emit(event: string, scope: MachineScope | null, payload: unknown): void {
    if (scope) this.io.to(this.rooms(scope)).emit(event, payload);
    else this.io.to("plant").emit(event, payload);
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.io.close();
    this.log.info("socket.io kapatıldı");
  }
}
