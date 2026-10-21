// Rapor kartı: başlık, grafik türü seçici (yalnızca veriye uygun türler), tablo görünümü, CSV, tam ekran.
import { Download, Maximize2, Minimize2, Table2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { download } from "../lib/api";
import { readPref, useUrlState, writePref } from "../lib/url-state";
import { Card, cn, Empty, ErrorBox, Segmented } from "./ui";

export interface ChartType<T extends string> {
  value: T;
  label: string;
  icon: ReactNode;
}

export function ChartCard<T extends string>({
  id,
  title,
  subtitle,
  types,
  defaultType,
  loading,
  error,
  empty,
  emptyText = "Seçilen aralıkta veri yok",
  csvPath,
  children,
  table,
  className,
  legend,
}: {
  id: string;
  title: string;
  subtitle?: ReactNode;
  types?: ChartType<T>[];
  defaultType?: T;
  loading?: boolean;
  error?: unknown;
  empty?: boolean;
  emptyText?: string;
  csvPath?: string;
  children: (type: T, setType: (t: T) => void) => ReactNode;
  table?: () => ReactNode;
  className?: string;
  legend?: ReactNode;
}) {
  // Seçim URL'de (paylaşılabilir) ve kullanıcı tercihi olarak saklanır.
  const fallback = (readPref(`chart:${id}`) as T | null) ?? defaultType ?? ("" as T);
  const [rawType, setType] = useUrlState<T>(`${id}.type`, types?.some((t) => t.value === fallback) ? fallback : (defaultType ?? ("" as T)));
  // Paylaşılan bağlantıda artık olmayan bir tür (ör. eski "table") varsayılana düşer
  const type = !types || types.some((t) => t.value === rawType) ? rawType : (defaultType ?? types[0]!.value);
  const [showTable, setShowTable] = useState(false);
  const [full, setFull] = useState(false);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  return (
    <Card className={cn("flex flex-col", full && "fixed inset-3 z-50 overflow-auto shadow-2xl", className)}>
      <div className="flex flex-wrap items-start justify-between gap-2 px-4 pt-4">
        <div className="min-w-0">
          <h3 className="font-semibold">{title}</h3>
          {subtitle && <p className="text-[12px] text-muted">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-1">
          {types && types.length > 1 && !showTable && (
            <Segmented
              size="sm"
              label={`${title} grafik türü`}
              value={type}
              options={types}
              onChange={(v) => {
                setType(v);
                writePref(`chart:${id}`, v);
              }}
            />
          )}
          {table && (
            <IconButton active={showTable} label={showTable ? "Grafik görünümü" : "Tablo görünümü"} onClick={() => setShowTable((v) => !v)}>
              <Table2 className="size-4" />
            </IconButton>
          )}
          {csvPath && (
            <IconButton label="CSV indir" onClick={() => void download(csvPath, `${id}.csv`)}>
              <Download className="size-4" />
            </IconButton>
          )}
          <IconButton label={full ? "Küçült" : "Tam ekran"} onClick={() => setFull((v) => !v)}>
            {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </IconButton>
        </div>
      </div>
      {legend && !showTable && <div className="px-4 pt-2">{legend}</div>}
      <div className={cn("relative flex-1 px-2 pt-2 pb-3 transition-opacity", loading && "opacity-50")} aria-busy={loading}>
        {error ? (
          <div className="p-2">
            <ErrorBox error={error} />
          </div>
        ) : empty && !loading ? (
          <Empty title={emptyText} />
        ) : showTable && table ? (
          <div className="px-2">{table()}</div>
        ) : (
          children(type, (v) => {
            setType(v);
            writePref(`chart:${id}`, v);
          })
        )}
      </div>
    </Card>
  );
}

function IconButton({ label, onClick, children, active }: { label: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn("rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-ink", active && "bg-surface-2 text-ink")}
    >
      {children}
    </button>
  );
}
