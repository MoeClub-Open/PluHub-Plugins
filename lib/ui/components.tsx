import { t as tr, textValue, getLocale } from "./i18n.js";
import { Select } from "./select.js";
import React from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import {
  LayoutDashboard,
  Layers,
  MessageSquare,
  Activity,
  KeyRound,
  SlidersHorizontal,
  Workflow,
  Users,
  Puzzle,
  ArrowRight,
  ArrowLeft,
  Settings2,
  Plus,
  RefreshCw,
  Sun,
  Moon,
  Monitor,
  ChevronsUpDown,
  ChevronDown,
  LogOut,
  Headset,
  Search,
  Clock,
  Check,
  Square,
  Copy,
  Menu,
  X,
  DollarSign,
  Trophy,
  Mail,
  ShieldCheck,
  Eye,
  EyeOff,
  Pencil,
  Trash2,
  type LucideIcon,
} from "lucide-react";
const icons: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  models: Layers,
  chat: MessageSquare,
  activity: Activity,
  key: KeyRound,
  channels: SlidersHorizontal,
  route: Workflow,
  users: Users,
  plugins: Puzzle,
  arrow: ArrowRight,
  back: ArrowLeft,
  settings: Settings2,
  plus: Plus,
  refresh: RefreshCw,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  chevrons: ChevronsUpDown,
  chevron: ChevronDown,
  logout: LogOut,
  support: Headset,
  search: Search,
  clock: Clock,
  check: Check,
  stop: Square,
  copy: Copy,
  menu: Menu,
  close: X,
  money: DollarSign,
  trophy: Trophy,
  mail: Mail,
  shield: ShieldCheck,
  eye: Eye,
  "eye-off": EyeOff,
  edit: Pencil,
  delete: Trash2,
};
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const Component = icons[name] ?? Puzzle;
  return <Component size={size} strokeWidth={1.6} aria-hidden="true" />;
}
export const number = (value: number | null | undefined) =>
  value == null
    ? "—"
    : new Intl.NumberFormat(getLocale(), {
        maximumFractionDigits: 1,
        notation: value >= 100000 ? "compact" : "standard",
      }).format(value);
export const latency = (value: number | null | undefined) =>
  value == null
    ? "—"
    : value < 1000
      ? Math.round(value) + " ms"
      : (value / 1000).toFixed(2) + " s";
export const money = (value: number | null | undefined) =>
  value == null ? "—" : "$" + value.toFixed(value < 0.01 ? 6 : 3);
export function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </div>
  );
}
export function ListPagination({
  total,
  page,
  size,
  setPage,
  setSize,
}: {
  total: number;
  page: number;
  size: number;
  setPage: (page: number) => void;
  setSize: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (total <= 10) return null;
  return (
    <div className="list-pagination">
      <span>{tr("共 {0} 条", { "0": textValue(total) })}</span>
      <label>
        {tr("每页")}{" "}
        <Select
          aria-label={tr("每页条数")}
          value={size}
          onChange={(e) => {
            setSize(Number(e.target.value));
            setPage(1);
          }}
        >
          {[10, 20, 50].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </label>
      <button
        className="secondary"
        disabled={page <= 1}
        onClick={() => setPage(page - 1)}
      >
        {tr("上一页")}
      </button>
      <span>
        {page} / {pages}
      </span>
      <button
        className="secondary"
        disabled={page >= pages}
        onClick={() => setPage(page + 1)}
      >
        {tr("下一页")}
      </button>
    </div>
  );
}
export function Empty({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name="models" size={26} />
      </span>
      <h3>{title}</h3>
      {description && <p className="muted">{description}</p>}
      {children}
    </div>
  );
}
export function Dialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(true);
  const onClose = React.useRef(close);
  onClose.current = close;
  React.useEffect(() => {
    if (open) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const timer = window.setTimeout(() => onClose.current(), reduced ? 0 : 120);
    return () => window.clearTimeout(timer);
  }, [open]);
  const [opener] = React.useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Portal forceMount>
        <div className="dialog-layer" data-state={open ? "open" : "closed"}>
          <RadixDialog.Overlay className="modal-overlay" />
          <RadixDialog.Content
            className="modal"
            aria-describedby={undefined}
            onInteractOutside={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => {
              if (opener?.isConnected) {
                event.preventDefault();
                opener.focus();
              }
            }}
          >
            <div className="modal-heading">
              <RadixDialog.Title>{title}</RadixDialog.Title>
              <RadixDialog.Close asChild>
                <button
                  type="button"
                  className="ghost icon-button"
                  aria-label={tr("关闭弹窗")}
                >
                  <Icon name="close" />
                </button>
              </RadixDialog.Close>
            </div>
            {children}
          </RadixDialog.Content>
        </div>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function Stat({
  title,
  value,
  note,
  icon,
}: {
  title: string;
  value: React.ReactNode;
  note?: string;
  icon: string;
}) {
  return (
    <article className="stat">
      <div className="stat-label">
        {title}
        <Icon name={icon} />
      </div>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </article>
  );
}
export interface Summary {
  requests: number;
  successes: number;
  errors: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
  usageKnownRequests: number;
  usageTotalRequests: number;
  pricedRequests: number;
  consumption: {
    source: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    usageKnownRequests: number;
    pricedRequests: number;
    estimatedCostUSD: number | null;
  }[];
  wallet: {
    chargedUSD: number | null;
    heldUSD: number | null;
    pendingRequests: number | null;
    unknownRequests: number;
  };
  avgLatencyMs: number | null;
  avgFirstTokenMs: number | null;
  series: { at: number; requests: number; errors: number }[];
  models: { model: string; requests: number; tokens: number }[];
}
export function RequestChart({ series }: { series: Summary["series"] }) {
  const container = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(800);
  React.useEffect(() => {
    const element = container.current!;
    const resize = (value: number) => {
      if (value > 0) setWidth(Math.max(280, Math.round(value)));
    };
    resize(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) resize(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const left = 44;
  const right = width - 16;
  const bottom = 170;
  const plotHeight = 146;
  const x = (index: number) =>
    left + (index * (right - left)) / Math.max(1, series.length - 1);
  const ticks = [
    ...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1]),
  ].filter((index) => index >= 0 && index < series.length);
  const max = Math.max(
    3,
    Math.ceil(Math.max(0, ...series.map((b) => b.requests)) / 3) * 3,
  );
  const coords = (key: "requests" | "errors") =>
    series
      .map((b, i) => `${x(i)},${bottom - (b[key] * plotHeight) / max}`)
      .join(" ");
  return (
    <div className="chart-wrap" ref={container}>
      <svg
        viewBox={`0 0 ${width} 210`}
        role="img"
        aria-label={tr("所选时间范围的请求量和错误数量")}
      >
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <line
              x1={left}
              x2={right}
              y1={24 + (i * plotHeight) / 3}
              y2={24 + (i * plotHeight) / 3}
              stroke="var(--border)"
              strokeDasharray="3 5"
            />
            <text x="32" y={28 + (i * plotHeight) / 3} textAnchor="end">
              {number((max * (3 - i)) / 3)}
            </text>
          </g>
        ))}
        <polygon
          points={`${left},${bottom} ${coords("requests")} ${right},${bottom}`}
          fill="var(--accent-soft)"
        />
        <polyline
          points={coords("requests")}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <polyline
          points={coords("errors")}
          fill="none"
          stroke="var(--danger)"
          strokeWidth="1.5"
          strokeDasharray="4 4"
        />
        {ticks.map((i, index) => (
          <text
            key={index}
            x={x(i)}
            y="200"
            textAnchor={
              index === 0
                ? "start"
                : index === ticks.length - 1
                  ? "end"
                  : "middle"
            }
          >
            {new Date(series[i]?.at ?? Date.now()).toLocaleString(getLocale(), {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </text>
        ))}
      </svg>
    </div>
  );
}
