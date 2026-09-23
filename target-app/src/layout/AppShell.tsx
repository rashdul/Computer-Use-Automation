import { useIsFetching, useIsMutating } from "@tanstack/react-query";
import {
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FilePlus2,
  History,
  LogOut,
  Percent,
  Search,
  ShieldCheck,
  TriangleAlert,
  Users,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useMatches, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { IdleMonitor } from "../auth/IdleMonitor";
import { EnvTag, Kbd } from "../components/display";
import { Logo, Mark } from "../components/Logo";
import { InterruptHost } from "../environment/InterruptHost";
import { initials } from "../lib/format";

export interface RouteHandle {
  crumb?: (params: Record<string, string | undefined>) => ReactNode;
}

export function AppShell() {
  const { environment } = useAuth();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("rfcu.console.sidebar") === "collapsed");
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [location.pathname]);

  const toggle = () => {
    setCollapsed((c) => {
      localStorage.setItem("rfcu.console.sidebar", c ? "expanded" : "collapsed");
      return !c;
    });
  };

  return (
    <div className="shell" data-collapsed={collapsed || undefined}>
      <a href="#main" className="sr-only">
        Skip to main content
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <div className="shell__main">
        <TopBar />
        {environment?.maintenance_banner && (
          <div className="maintenance-bar" role="status">
            <TriangleAlert size={15} aria-hidden="true" />
            {environment.maintenance_banner}
          </div>
        )}
        <main className="shell__content" id="main" ref={mainRef} tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <IdleMonitor />
      <InterruptHost />
    </div>
  );
}

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { context, can } = useAuth();
  const tip = (label: string) => (collapsed ? { "data-tip": label, "data-tip-side": "right" } : {});
  return (
    <aside className="sidebar" aria-label="Primary">
      <Link to="/members" className="sidebar__brand" aria-label="Rashed Federal Credit Union — Member search">
        {collapsed ? <Mark size={30} tone="dark" /> : <Logo tone="dark" size={30} />}
      </Link>
      <nav className="sidebar__nav">
        <div className="nav-group">
          <div className="nav-group__label">Members</div>
          <NavLink to="/members" className="nav-link" {...tip("Member search")}>
            <Users aria-hidden="true" />
            <span>Member search</span>
          </NavLink>
          <NavLink to="/open-account" className="nav-link" {...tip("Open sub-account")}>
            <FilePlus2 aria-hidden="true" />
            <span>Open sub-account</span>
          </NavLink>
        </div>
        <div className="nav-group">
          <div className="nav-group__label">Reference</div>
          <NavLink to="/products" className="nav-link" {...tip("Product rates")}>
            <Percent aria-hidden="true" />
            <span>Product rates</span>
          </NavLink>
          <NavLink to="/activity" className="nav-link" {...tip("My activity")}>
            <History aria-hidden="true" />
            <span>My activity</span>
          </NavLink>
        </div>
        {can("admin.console") && (
          <div className="nav-group">
            <div className="nav-group__label">Oversight</div>
            <NavLink to="/admin" className="nav-link" {...tip("Administration")}>
              <ShieldCheck aria-hidden="true" />
              <span>Administration</span>
            </NavLink>
          </div>
        )}
      </nav>
      <div className="sidebar__foot">
        {context && (
          <div className="sidebar__station">
            <strong>
              {context.branch.code} · {context.branch.name}
            </strong>
            <span className="mono">{context.staff.workstation}</span>
          </div>
        )}
        <button type="button" className="sidebar__collapse" onClick={onToggle} aria-expanded={!collapsed} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
          {collapsed ? <ChevronsRight size={15} aria-hidden="true" /> : <ChevronsLeft size={15} aria-hidden="true" />}
          <span>Collapse</span>
        </button>
      </div>
    </aside>
  );
}

function Breadcrumbs() {
  const matches = useMatches();
  const all = matches
    .filter((m) => (m.handle as RouteHandle | undefined)?.crumb)
    .map((m) => ({ id: m.id, path: m.pathname, node: (m.handle as RouteHandle).crumb!(m.params) }));
  // deep paths keep the section, the member, and the last two steps (drops "Accounts" inside the opening flow)
  const crumbs = all.length > 4 ? [...all.slice(0, 2), ...all.slice(-2)] : all;
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={c.id} style={{ display: "contents" }}>
            {i > 0 && <ChevronRight size={13} className="crumbs__sep" aria-hidden="true" />}
            {last ? (
              <span className="crumbs__current" aria-current="page">
                {c.node}
              </span>
            ) : (
              <Link to={c.path}>{c.node}</Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <span className="topbar__clock">
      {now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" })} ·{" "}
      {now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET
    </span>
  );
}

function QuickFind() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.closest("input, textarea, select, [contenteditable='true']");
      if (e.key === "/" && !typing && !document.querySelector("[aria-modal='true']")) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <form
      className="quick-find"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const q = value.trim();
        if (!q) return;
        navigate(`/members?q=${encodeURIComponent(q)}`);
        setValue("");
        inputRef.current?.blur();
      }}
    >
      <Search size={14} className="quick-find__icon" aria-hidden="true" />
      <label htmlFor="quick-find" className="sr-only">
        Find a member
      </label>
      <input
        ref={inputRef}
        id="quick-find"
        className="input"
        placeholder="Find member"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Kbd>/</Kbd>
    </form>
  );
}

function UserMenu() {
  const { context, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!context) return null;
  const { staff } = context;
  return (
    <div className="user-menu" ref={ref}>
      <button type="button" className="user-menu__button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="initials" aria-hidden="true">
          {initials(staff.full_name)}
        </span>
        <span>
          <span className="user-menu__name">{staff.full_name}</span>
          <span className="user-menu__role">{staff.role_label}</span>
        </span>
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Account">
          <div className="menu__header">
            <strong>{staff.full_name}</strong>
            {staff.title} · <span className="mono">{staff.employee_id}</span>
          </div>
          <Link to="/activity" className="menu__item" role="menuitem" onClick={() => setOpen(false)}>
            <History size={15} aria-hidden="true" />
            My activity
          </Link>
          <button type="button" className="menu__item" role="menuitem" onClick={() => void signOut()}>
            <LogOut size={15} aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function TopBar() {
  const fetching = useIsFetching();
  const mutating = useIsMutating();
  return (
    <header className="topbar">
      <Breadcrumbs />
      <div className="topbar__spacer" />
      <QuickFind />
      <div className="topbar__meta">
        <EnvTag />
        <Clock />
      </div>
      <UserMenu />
      <div className="top-progress" data-active={fetching + mutating > 0} aria-hidden="true" />
    </header>
  );
}
