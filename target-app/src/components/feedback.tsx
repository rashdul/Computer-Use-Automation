import clsx from "clsx";
import { CircleAlert, CircleCheck, Clock3, Info, RefreshCw, TriangleAlert, WifiOff } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useSlow } from "../hooks/useSlow";
import { isApiError } from "../lib/errors";
import { Button } from "./Button";

type BannerTone = "info" | "ok" | "warn" | "bad";

const BANNER_ICON: Record<BannerTone, ReactNode> = {
  info: <Info size={16} aria-hidden="true" />,
  ok: <CircleCheck size={16} aria-hidden="true" />,
  warn: <TriangleAlert size={16} aria-hidden="true" />,
  bad: <CircleAlert size={16} aria-hidden="true" />,
};

interface BannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  live?: boolean;
  id?: string;
}

export function Banner({ tone = "info", title, children, actions, className, live, id }: BannerProps) {
  return (
    <div
      className={clsx("banner", `banner--${tone}`, className)}
      role={live ? (tone === "bad" ? "alert" : "status") : undefined}
      id={id}
      tabIndex={id ? -1 : undefined}
    >
      {BANNER_ICON[tone]}
      <div className="banner__body">
        {title && <div className="banner__title">{title}</div>}
        {children && <div className="banner__text">{children}</div>}
      </div>
      {actions && <div className="banner__actions">{actions}</div>}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function Skeleton({ width = "100%", height = 12, style }: { width?: number | string; height?: number; style?: React.CSSProperties }) {
  return <span className="skeleton" style={{ width, height, ...style }} aria-hidden="true" />;
}

export function SkeletonLines({ lines = 5 }: { lines?: number }) {
  return (
    <div className="stack stack--sm" aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={`${70 + ((i * 37) % 30)}%`} />
      ))}
    </div>
  );
}

/** Shown while a request is still pending past the configured slow threshold. */
export function SlowNotice({ active, what = "this information" }: { active: boolean; what?: string }) {
  const { slow, seconds } = useSlow(active);
  if (!slow) return null;
  return (
    <div className="slow-notice" role="status">
      <Clock3 size={15} aria-hidden="true" />
      <span>
        Still loading {what}. The core banking service is responding slowly — you can keep waiting.
      </span>
      <span className="slow-notice__elapsed">{seconds}s</span>
    </div>
  );
}

interface EmptyProps {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}

export function EmptyState({ icon, title, children, actions }: EmptyProps) {
  return (
    <div className="empty">
      {icon && <div className="empty__icon">{icon}</div>}
      <div className="empty__title">{title}</div>
      {children && <div className="empty__text">{children}</div>}
      {actions && <div className="empty__actions">{actions}</div>}
    </div>
  );
}

interface StatePageProps {
  tone?: "bad" | "warn" | "info" | "neutral";
  code: string;
  title: ReactNode;
  children?: ReactNode;
  facts?: ReactNode;
  actions?: ReactNode;
  foot?: ReactNode;
}

/** Full-width outcome page: not found, permission denied, session expired, errors. */
export function StatePage({ tone = "neutral", code, title, children, facts, actions, foot }: StatePageProps) {
  return (
    <section className={clsx("state", `state--${tone}`)} aria-labelledby="state-title">
      <div className="state__stripe" />
      <div className="state__body">
        <div className="state__code">{code}</div>
        <h1 className="state__title" id="state-title">
          {title}
        </h1>
        {children && <div className="state__text">{children}</div>}
        {facts && <div className="state__facts">{facts}</div>}
        {actions && <div className="state__actions">{actions}</div>}
      </div>
      {foot && <div className="state__foot">{foot}</div>}
    </section>
  );
}

/**
 * Inline error for failed loads (timeouts, outages, unexpected errors) with a retry.
 * `onRetry` may return a promise (e.g. a query refetch); the button shows progress until it settles.
 */
export function LoadError({ error, onRetry, what = "this information" }: { error: unknown; onRetry?: () => unknown; what?: string }) {
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry?.();
    } finally {
      setRetrying(false);
    }
  };
  let title = `Couldn't load ${what}`;
  let text = "Something went wrong on our side.";
  let icon = <CircleAlert size={16} aria-hidden="true" />;
  let reference: string | undefined;

  if (isApiError(error)) {
    reference = error.reference;
    switch (error.kind) {
      case "timeout":
        title = "The request timed out";
        text = `${error.message} The core banking service didn't answer in time. Try again; if it keeps happening, tell the Help Desk.`;
        icon = <Clock3 size={16} aria-hidden="true" />;
        break;
      case "unavailable":
        title = "Core banking service unavailable";
        text = "The service didn't accept the request. Wait a moment and try again.";
        break;
      case "network":
        title = "No connection to the core banking service";
        text = "Check the workstation's network connection, then try again.";
        icon = <WifiOff size={16} aria-hidden="true" />;
        break;
      case "validation":
        title = "The request was rejected";
        text = error.fields.map((f) => f.message).join(" ") || "Check the values and try again.";
        break;
      default:
        text = error.message && error.message !== "Unexpected error" ? error.message : text;
    }
  }

  return (
    <div className="banner banner--bad" role="alert">
      {icon}
      <div className="banner__body">
        <div className="banner__title">{title}</div>
        <div className="banner__text">
          {text}
          {reference && (
            <>
              {" "}
              Reference <span className="mono">{reference}</span>.
            </>
          )}
        </div>
      </div>
      {onRetry && (
        <div className="banner__actions">
          <Button size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={() => void retry()} loading={retrying} loadingText="Trying again…">
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
