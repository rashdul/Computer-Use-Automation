import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { count } from "../lib/format";
import { Button } from "./Button";
import { Skeleton } from "./feedback";

export interface TabItem {
  to: string;
  label: string;
  count?: number;
  end?: boolean;
  icon?: ReactNode;
}

export function Tabs({ items, label }: { items: TabItem[]; label: string }) {
  return (
    <nav className="tabs" aria-label={label}>
      {items.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className="tab">
          {t.icon}
          {t.label}
          {t.count !== undefined && <span className="tab__count">{count(t.count)}</span>}
        </NavLink>
      ))}
    </nav>
  );
}

interface PagerProps {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
  noun?: string;
  disabled?: boolean;
}

export function Pager({ total, limit, offset, onChange, noun = "results", disabled }: PagerProps) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <nav className="pager" aria-label="Pagination">
      <span className="pager__range">
        {count(from)}–{count(to)} of {count(total)} {noun}
      </span>
      <span className="pager__buttons">
        <Button
          size="sm"
          icon={<ChevronLeft size={14} aria-hidden="true" />}
          disabled={disabled || offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          Previous
        </Button>
        <span className="pager__range" aria-current="page">
          Page {count(page)} of {count(pages)}
        </span>
        <Button
          size="sm"
          iconAfter={<ChevronRight size={14} aria-hidden="true" />}
          disabled={disabled || offset + limit >= total}
          onClick={() => onChange(offset + limit)}
        >
          Next
        </Button>
      </span>
    </nav>
  );
}

/** Placeholder rows while a table loads. */
export function SkeletonRows({ columns, rows = 8 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} aria-hidden="true">
          {Array.from({ length: columns }).map((__, c) => (
            <td key={c}>
              <Skeleton width={`${45 + ((r * 13 + c * 29) % 45)}%`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
