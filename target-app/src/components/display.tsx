import clsx from "clsx";
import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { money } from "../lib/format";
import type { Tone } from "../lib/labels";

export function Badge({ tone = "neutral", dot, children, title }: { tone?: Tone; dot?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className={clsx("badge", `badge--${tone}`, dot && "badge--dot")} title={title}>
      {children}
    </span>
  );
}

export function Suffix({ value, loan }: { value: string; loan?: boolean }) {
  return <span className={clsx("suffix", loan && "suffix--loan")}>{value}</span>;
}

export function Money({ value, credit, className }: { value: number | null | undefined; credit?: boolean; className?: string }) {
  return <span className={clsx("num", credit && "amount-credit", className)}>{money(value)}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function EnvTag() {
  return (
    <span className="env-tag" data-tip="User acceptance testing · synthetic member data">
      UAT
    </span>
  );
}

interface PanelProps {
  title?: ReactNode;
  icon?: ReactNode;
  count?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  className?: string;
  children?: ReactNode;
  id?: string;
  as?: "section" | "div";
}

export function Panel({ title, icon, count, actions, footer, flush, className, children, id, as = "section" }: PanelProps) {
  const Tag = as;
  const headingId = id ? `${id}-title` : undefined;
  return (
    <Tag className={clsx("panel", className)} id={id} aria-labelledby={title ? headingId : undefined}>
      {(title || actions) && (
        <header className="panel__header">
          {title && (
            <h2 className="panel__title" id={headingId}>
              {icon}
              {title}
              {count !== undefined && <span className="panel__count">{count}</span>}
            </h2>
          )}
          {actions && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      <div className={clsx("panel__body", flush && "panel__body--flush")}>{children}</div>
      {footer && <footer className="panel__footer">{footer}</footer>}
    </Tag>
  );
}

export function DL({ items, wide, className }: { items: ([ReactNode, ReactNode] | "sep")[]; wide?: boolean; className?: string }) {
  return (
    <dl className={clsx("dl", wide && "dl--wide", className)}>
      {items.map((item, i) =>
        item === "sep" ? (
          <div key={i} className="dl__sep" role="presentation" />
        ) : (
          <FragmentRow key={i} term={item[0]} value={item[1]} />
        ),
      )}
    </dl>
  );
}

function FragmentRow({ term, value }: { term: ReactNode; value: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{value ?? "—"}</dd>
    </>
  );
}

export function Stats({ items }: { items: { label: string; value: ReactNode; sub?: ReactNode }[] }) {
  return (
    <div className="stats">
      {items.map((s) => (
        <div className="stat" key={s.label}>
          <div className="stat__label">{s.label}</div>
          <div className="stat__value">{s.value}</div>
          {s.sub && <div className="stat__sub">{s.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/** Copies text; confirms with a check for 1.5 s. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-btn"
      aria-label={copied ? "Copied" : label}
      data-tip={copied ? "Copied" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable; nothing to do */
        }
      }}
    >
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}
