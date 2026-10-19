// API yanıt tipleri (apps/api ile uyumlu).

export type MachineState = "running" | "stopped" | "offline";
export type StateSource = "tag" | "counter";
export type ScrapSource = "plc" | "manual";
export type TagRole = "total_count" | "scrap_count" | "running" | "state_code" | "process";

export interface Machine {
  id: number;
  line_id: number;
  code: string;
  name: string;
  is_active: boolean;
  state_source: StateSource;
  counter_idle_seconds: number;
  scrap_source: ScrapSource;
  sort_order: number;
  has_plc_config: boolean;
  edge_id: number | null;
  tag_count: number;
}

export interface Tag {
  name: string;
  address: string;
  role: TagRole;
  unit?: string | null;
}

export interface PlcConfig {
  protocol: "s7";
  edge_id: number | null;
  edge_code?: string;
  host: string;
  port: number;
  rack: number;
  slot: number;
  poll_ms: number;
  tags: Tag[];
  updated_at?: string;
  updated_by?: number | null;
  warnings?: string[];
}

export interface MachineDetail extends Machine {
  plc: PlcConfig | null;
}

export interface Line {
  id: number;
  area_id: number;
  slug: string;
  name: string;
  sort_order: number;
}

export interface Edge {
  id: number;
  code: string;
  name: string;
  nodered_url: string;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  machine_count: number;
  machines: string[];
}

export interface EdgeCheck {
  edge: string;
  url: string;
  ok: boolean;
  items: { status: "ok" | "warn" | "error"; text: string }[];
  node_red_version?: string;
  s7_version?: string;
  tabs?: { label: string; managed: boolean }[];
  existing_s7_endpoints?: { address: string; port: string; rack: string; slot: string; cycletime: string; variables: number }[];
}

export interface Area {
  id: number;
  slug: string;
  name: string;
  sort_order: number;
}

export interface HierarchyArea extends Area {
  lines: (Line & { machines: Machine[] })[];
}

export interface Losses {
  availability_seconds: number;
  performance_seconds: number | null;
  quality_seconds: number | null;
  fully_productive_seconds: number | null;
}

export interface OeeMetrics {
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
  shift_seconds: number;
  planned_stop_seconds: number;
  no_data_seconds: number;
  planned_seconds: number;
  run_seconds: number;
  unplanned_downtime_seconds: number;
  changeover_seconds: number;
  unassigned_downtime_seconds: number;
  total_count: number;
  good_count: number;
  scrap_count: number;
  off_plan_count: number;
  unattributed_count: number;
  losses: Losses;
  machine_count: number;
  warnings: string[];
}

export interface Window {
  from: string;
  to: string;
  label: string;
  timezone: string;
}

export interface SeriesPoint extends OeeMetrics {
  label: string;
  from: string;
  to: string;
  machines?: (Pick<OeeMetrics, "availability" | "performance" | "quality" | "oee" | "total_count" | "planned_seconds" | "run_seconds"> & {
    machine_id: number;
    code: string;
  })[];
}

export interface OeeResponse {
  window: Window;
  summary: OeeMetrics;
  series: SeriesPoint[];
  machines?: (OeeMetrics & { machine_id: number; code: string; name: string; line_id: number; line_name: string })[];
  lines?: (OeeMetrics & { line_id: number; line_name: string })[];
}

export interface ParetoReason {
  reason_id: number | null;
  code: string | null;
  name: string;
  category: "unplanned" | "planned" | "changeover" | "unassigned";
  seconds: number;
  count: number;
  share: number;
  cumulative_share: number;
}

export interface ParetoResponse {
  window: Window;
  total_seconds: number;
  reasons: ParetoReason[];
}

export interface TimelineSegment {
  state: MachineState;
  from: string;
  to: string;
  open: boolean;
}

export interface TimelineDowntime {
  id: number;
  from: string;
  to: string;
  open: boolean;
  reason_id: number | null;
  reason: string | null;
  category: ParetoReason["category"];
}

export interface TimelineResponse {
  window: Window;
  machines: { machine_id: number; code: string; name: string; segments: TimelineSegment[]; downtimes: TimelineDowntime[] }[];
  shifts: { label: string; from: string; to: string; planned_stops: { from: string; to: string }[] }[];
}

export interface ProductionResponse {
  window: Window;
  series: { label: string; from: string; to: string; total_count: number; scrap_count: number; good_count: number }[];
  totals: { total_count: number; scrap_count: number; good_count: number };
}

export interface TelemetryResponse {
  window: Pick<Window, "from" | "to" | "label">;
  bucket_seconds: number;
  series: Record<string, { ts: string; avg: number; min: number; max: number; n: number }[]>;
}

export interface LiveOee {
  window: Window;
  summary: Pick<OeeMetrics, "availability" | "performance" | "quality" | "oee" | "total_count" | "planned_seconds" | "run_seconds" | "unattributed_count">;
  machines: (LiveOee["summary"] & { machine_id: number; code: string; scrap_count: number })[];
}

export type OrderStatus = "planned" | "running" | "paused" | "done" | "cancelled";

export interface ProductionOrder {
  id: number;
  order_no: string;
  product_id: number;
  product_code: string;
  product_name: string;
  machine_id: number;
  machine_code: string;
  machine_name: string;
  target_qty: number;
  status: OrderStatus;
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_by: string | null;
  produced_qty: number;
  scrap_qty: number;
  good_qty: number;
  progress: number;
  ideal_cycle_seconds: number | null;
  remaining_ideal_seconds: number | null;
}

export interface Downtime {
  id: number;
  machine_id: number;
  machine_code: string;
  machine_name: string;
  line_id: number;
  start_ts: string;
  end_ts: string | null;
  duration_seconds: number;
  reason_id: number | null;
  reason_code: string | null;
  reason_name: string | null;
  category: ParetoReason["category"];
  note: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  open: boolean;
}

export interface DowntimeReason {
  id: number;
  code: string;
  name: string;
  category: "unplanned" | "planned" | "changeover";
  parent_id: number | null;
  is_active: boolean;
  sort_order: number;
}

export interface Product {
  id: number;
  code: string;
  name: string;
  is_active: boolean;
}

export interface Rate {
  product_id: number;
  machine_id: number;
  machine_code: string;
  ideal_cycle_seconds: string | number;
}

export interface Shift {
  id: number;
  name: string;
  start_local: string;
  end_local: string;
  days_mask: number;
  is_active: boolean;
  planned_stops: { id?: number; name: string; start_local: string; duration_minutes: number }[];
}

export interface PlantSettings {
  timezone: string;
  min_downtime_seconds: number;
  raw_retention_days: number;
  edge_heartbeat_timeout_seconds: number;
}

export interface UserRow {
  id: number;
  username: string;
  display_name: string | null;
  role: "admin" | "engineer" | "operator" | "viewer";
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface FlowDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
  has_changes: boolean;
}

export interface EdgePlan {
  edge_id: number;
  code: string;
  name: string;
  url: string;
  machine_count: number;
  error: string | null;
  rev: string | null;
  diff: FlowDiff | null;
  node_count: number;
}

export interface FlowPreview {
  edges: EdgePlan[];
  has_changes: boolean;
  unreachable: string[];
  warnings: string[];
}

export interface DeployResult {
  edge_id: number;
  code: string;
  status: "deployed" | "unchanged" | "failed" | "conflict";
  error?: string;
  rev?: string;
}

export interface Deployment {
  id: number;
  deployed_at: string;
  status: "success" | "partial" | "failed";
  summary: { diff?: FlowDiff | null; warnings?: string[] } | null;
  error: string | null;
  deployed_by: string | null;
  edge_code: string | null;
}

export interface OperatorView {
  machine: { id: number; code: string; name: string; scrap_source: ScrapSource };
  active_order: ProductionOrder | null;
  queue: ProductionOrder[];
  unassigned_downtimes: Downtime[];
}
