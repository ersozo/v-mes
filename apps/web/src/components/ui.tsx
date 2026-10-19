// Temel arayüz bileşenleri. Sade: hairline kenarlıklar, tek vurgu rengi, bol boşluk.
import clsx from "clsx";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

export function cn(...args: Parameters<typeof clsx>): string {
  return clsx(...args);
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  icon,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" && "h-8 px-3 text-[13px]",
        size === "md" && "h-9 px-3.5",
        size === "lg" && "h-14 px-6 text-base",
        variant === "primary" && "bg-accent text-accent-ink hover:brightness-110",
        variant === "secondary" && "border border-line bg-surface text-ink hover:bg-surface-2",
        variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
        variant === "danger" && "border border-line bg-surface text-danger hover:bg-surface-2",
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn("rounded-xl border border-line bg-surface", className)}>
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[13px] font-medium text-ink-2">
        {label}
      </label>
      {children(id)}
      {error ? <p className="text-[12px] text-danger">{error}</p> : hint ? <p className="text-[12px] text-muted">{hint}</p> : null}
    </div>
  );
}

const inputClass =
  "h-9 rounded-lg border border-line bg-surface px-3 text-ink placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cn(inputClass, !/(^|\s)w-/.test(className ?? "") && "w-full", className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cn(inputClass, "pr-8", !/(^|\s)w-/.test(className ?? "") && "w-full", className)}>
      {children}
    </select>
  );
}

export function Checkbox({ label, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-ink-2">
      <input type="checkbox" {...rest} className="size-4 accent-[var(--accent)]" />
      {label}
    </label>
  );
}

/** Segmentli seçim (grafik türü, dönem gruplama gibi az seçenekli durumlar). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "md",
  label,
}: {
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          title={o.label}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md font-medium text-ink-2 transition-colors hover:text-ink",
            size === "sm" ? "h-7 px-2 text-[12px]" : "h-8 px-3 text-[13px]",
            o.value === value && "bg-surface text-ink shadow-[0_0_0_1px_var(--border)]",
          )}
        >
          {o.icon}
          {o.icon && size === "sm" ? <span className="sr-only">{o.label}</span> : o.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "good" | "warning" | "critical" | "accent"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium",
        tone === "neutral" && "bg-surface-2 text-ink-2",
        tone === "accent" && "bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-ink",
        tone === "good" && "bg-[color-mix(in_oklab,var(--status-good)_16%,transparent)] text-ink",
        tone === "warning" && "bg-[color-mix(in_oklab,var(--status-warning)_22%,transparent)] text-ink",
        tone === "critical" && "bg-[color-mix(in_oklab,var(--status-critical)_16%,transparent)] text-ink",
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ label = "Yükleniyor" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-muted" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-line bg-surface-2 p-3 text-ink-2">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--status-serious)]" aria-hidden />
      <div className="flex-1 whitespace-pre-line">{message}</div>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Tekrar dene
        </Button>
      )}
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-md text-ink-2">{children}</div>}
    </div>
  );
}

export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={cn(
        "m-auto max-h-[90vh] w-[calc(100%-2rem)] rounded-xl border border-line bg-surface p-0 text-ink backdrop:bg-black/40",
        wide ? "max-w-4xl" : "max-w-lg",
      )}
    >
      {open && (
        <div className="flex max-h-[90vh] flex-col">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 className="font-semibold">{title}</h2>
            <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Kapat">
              <X className="size-4" />
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/** Basit tablo kabuğu (yatay kaydırmalı). */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-left text-[13px] [&_td]:border-t [&_td]:border-line [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2 [&_th]:font-medium [&_th]:text-muted">
        {children}
      </table>
    </div>
  );
}
