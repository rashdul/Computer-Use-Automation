import { ApiError, makeReference } from "./errors";
import { supabase } from "./supabase";
import type {
  AccountDetail,
  AdminOverview,
  AdminProduct,
  AuditRow,
  EnvironmentSettings,
  MemberAccounts,
  MemberBrief,
  MemberDetail,
  Note,
  NoteCategory,
  OpenAccountRequest,
  OpenContext,
  OpeningReceipt,
  Paged,
  Permission,
  PermissionMatrix,
  Product,
  RecentMember,
  Role,
  Scope,
  SearchResult,
  SessionContext,
  SessionRow,
  StaffRow,
  TestScenario,
  TransactionPage,
} from "./types";

/* ---------------------------------------------------------------------------
 * UAT fault injection
 *
 * Administration → Environment controls sets latency and failure injection
 * per request category. Session and administration calls are never slowed or
 * failed, so the controls can always be turned back off.
 * ------------------------------------------------------------------------- */

type Category = Exclude<Scope, "all"> | "session" | "admin" | "reference";

const CATEGORY: Record<string, Category> = {
  search_members: "search",
  get_recent_members: "search",
  get_member: "member",
  reveal_member_ssn: "member",
  get_member_notes: "member",
  add_member_note: "member",
  get_member_access_log: "member",
  get_member_accounts: "accounts",
  get_account: "accounts",
  get_account_transactions: "accounts",
  get_open_account_context: "account_opening",
  lookup_member_brief: "account_opening",
  open_sub_account: "account_opening",
  get_account_opening: "account_opening",
  get_products: "reference",
  get_my_activity: "reference",
};

let environment: EnvironmentSettings | null = null;
let sessionExpiredHandler: (reason: "revoked" | "disabled") => void = () => {};

export function setEnvironment(env: EnvironmentSettings | null) {
  environment = env;
}

export function getEnvironment(): EnvironmentSettings | null {
  return environment;
}

export function onSessionExpired(handler: (reason: "revoked" | "disabled") => void) {
  sessionExpiredHandler = handler;
}

function inScope(scope: Scope, category: Category) {
  if (category === "session" || category === "admin" || category === "reference") return false;
  return scope === "all" || scope === category;
}

function injectedLatency(env: EnvironmentSettings): number {
  if (env.latency_mode === "fixed") return env.latency_fixed_ms;
  if (env.latency_mode === "random") {
    return env.latency_min_ms + Math.random() * (env.latency_max_ms - env.latency_min_ms);
  }
  return 0;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

interface PostgrestLikeError {
  code?: string;
  message?: string;
  details?: unknown;
  hint?: string | null;
}

function toApiError(error: PostgrestLikeError, status: number, timedOut: boolean, timeoutMs: number): ApiError {
  const code = error.code ?? "";
  const details = error.details;
  switch (code) {
    case "PT401":
      return new ApiError({ kind: "session_expired", status: 401, code, message: String(details ?? "Session expired") });
    case "PT403":
      return new ApiError({ kind: "account_disabled", status: 403, code, message: String(details ?? "Account disabled") });
    case "RF428":
      return new ApiError({ kind: "step_up_required", status: 428, code, message: "Confirm your password to continue.", details });
    case "RF403":
      return new ApiError({
        kind: "permission_denied",
        status: 403,
        code,
        message: "permission_denied",
        details,
        reference: (details as { reference?: string } | undefined)?.reference,
      });
    case "RF404":
      return new ApiError({ kind: "not_found", status: 404, code, message: error.message ?? "not_found", details });
    case "RF422":
      return new ApiError({ kind: "validation", status: 422, code, message: "validation_failed", details });
    case "RF409":
      return new ApiError({ kind: "conflict", status: 409, code, message: error.message ?? "conflict", details });
  }
  if (status === 401) {
    return new ApiError({ kind: "session_expired", status, code, message: "Session expired" });
  }
  if (status === 0) {
    return timedOut
      ? new ApiError({ kind: "timeout", status: 0, message: `No response after ${Math.round(timeoutMs / 1000)} seconds.`, reference: makeReference("TMO") })
      : new ApiError({ kind: "network", status: 0, message: "The console couldn't reach the core banking service.", reference: makeReference("NET") });
  }
  return new ApiError({
    kind: "server",
    status,
    code,
    message: error.message ?? "Unexpected error",
    details,
    reference: makeReference("ERR"),
  });
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const category = CATEGORY[fn] ?? (fn.startsWith("admin_") ? "admin" : "session");
  const env = environment;
  const timeoutMs = env?.request_timeout_ms ?? 15000;
  const controller = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    if (env && env.latency_mode !== "off" && inScope(env.latency_scope, category)) {
      await wait(injectedLatency(env), controller.signal);
    }
    if (env && env.failure_rate_pct > 0 && inScope(env.failure_scope, category) && Math.random() * 100 < env.failure_rate_pct) {
      await wait(200 + Math.random() * 300, controller.signal);
      throw new ApiError({
        kind: "unavailable",
        status: 503,
        message: "The core banking service is temporarily unavailable.",
        reference: makeReference("SVC"),
      });
    }

    const { data, error, status } = await supabase.rpc(fn, args).abortSignal(controller.signal);
    if (error) throw toApiError(error as PostgrestLikeError, status, timedOut, timeoutMs);
    return data as T;
  } catch (e) {
    let err: ApiError;
    if (e instanceof ApiError) err = e;
    else if (timedOut) err = toApiError({}, 0, true, timeoutMs);
    else err = toApiError({ message: String(e) }, 0, false, timeoutMs);

    if (err.kind === "session_expired") sessionExpiredHandler("revoked");
    if (err.kind === "account_disabled") sessionExpiredHandler("disabled");
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------------------
 * Typed operations
 * ------------------------------------------------------------------------- */

export interface SearchParams {
  query: string;
  status?: string;
  branch?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface TxnFilters {
  from?: string;
  to?: string;
  direction?: "all" | "credit" | "debit";
  search?: string;
  limit?: number;
  offset?: number;
}

export const api = {
  sessionContext: () => rpc<SessionContext>("get_session_context"),
  heartbeat: () =>
    rpc<{ server_time: string; environment: EnvironmentSettings; permissions: Permission[] }>("session_heartbeat"),
  recordAuthEvent: (event: "sign_in" | "sign_out" | "idle_timeout" | "step_up", details: Record<string, unknown> = {}) =>
    rpc<{ ok: boolean }>("record_auth_event", { p_event: event, p_details: details }),

  searchMembers: (p: SearchParams) =>
    rpc<SearchResult>("search_members", {
      p_query: p.query,
      p_status: p.status || null,
      p_branch: p.branch || null,
      p_sort: p.sort || "relevance",
      p_limit: p.limit ?? 25,
      p_offset: p.offset ?? 0,
    }),
  recentMembers: () => rpc<RecentMember[]>("get_recent_members"),
  member: (memberNumber: string) => rpc<MemberDetail>("get_member", { p_member_number: memberNumber }),
  revealSsn: (memberNumber: string) =>
    rpc<{ ssn: string; revealed_at: string }>("reveal_member_ssn", { p_member_number: memberNumber }),
  notes: (memberNumber: string, limit = 20, offset = 0) =>
    rpc<Paged<Note>>("get_member_notes", { p_member_number: memberNumber, p_limit: limit, p_offset: offset }),
  addNote: (memberNumber: string, category: NoteCategory | "", body: string, pinned: boolean) =>
    rpc<Note>("add_member_note", { p_member_number: memberNumber, p_category: category || null, p_body: body, p_is_pinned: pinned }),
  accessLog: (memberNumber: string, limit = 25, offset = 0) =>
    rpc<Paged<AuditRow>>("get_member_access_log", { p_member_number: memberNumber, p_limit: limit, p_offset: offset }),
  myActivity: (limit = 50, offset = 0, outcome?: string) =>
    rpc<Paged<AuditRow>>("get_my_activity", { p_limit: limit, p_offset: offset, p_outcome: outcome || null }),

  memberAccounts: (memberNumber: string, includeClosed = false) =>
    rpc<MemberAccounts>("get_member_accounts", { p_member_number: memberNumber, p_include_closed: includeClosed }),
  account: (memberNumber: string, accountNumber: string) =>
    rpc<AccountDetail>("get_account", { p_member_number: memberNumber, p_account_number: accountNumber }),
  transactions: (memberNumber: string, accountNumber: string, f: TxnFilters) =>
    rpc<TransactionPage>("get_account_transactions", {
      p_member_number: memberNumber,
      p_account_number: accountNumber,
      p_from: f.from || null,
      p_to: f.to || null,
      p_direction: f.direction ?? "all",
      p_search: f.search || null,
      p_limit: f.limit ?? 25,
      p_offset: f.offset ?? 0,
    }),
  products: () => rpc<Product[]>("get_products"),

  openContext: (memberNumber: string) => rpc<OpenContext>("get_open_account_context", { p_member_number: memberNumber }),
  lookupMember: (memberNumber: string) => rpc<MemberBrief>("lookup_member_brief", { p_member_number: memberNumber }),
  openSubAccount: (request: OpenAccountRequest) => rpc<OpeningReceipt>("open_sub_account", { p_request: request }),
  opening: (confirmation: string) => rpc<OpeningReceipt>("get_account_opening", { p_confirmation_number: confirmation }),

  admin: {
    overview: () => rpc<AdminOverview>("admin_get_overview"),
    staff: () => rpc<StaffRow[]>("admin_list_staff"),
    updateStaff: (staffId: string, role?: Role, isActive?: boolean) =>
      rpc<{ changed: boolean; sessions_ended?: number }>("admin_update_staff", {
        p_staff_id: staffId,
        p_role: role ?? null,
        p_is_active: isActive ?? null,
      }),
    sessions: () => rpc<SessionRow[]>("admin_list_sessions"),
    endSessions: (staffId?: string) => rpc<{ sessions_ended: number }>("admin_end_sessions", { p_staff_id: staffId ?? null }),
    permissions: () => rpc<PermissionMatrix>("admin_get_permissions"),
    setPermission: (role: Role, permission: Permission, granted: boolean) =>
      rpc<{ changed: boolean }>("admin_set_role_permission", { p_role: role, p_permission: permission, p_granted: granted }),
    environment: () => rpc<EnvironmentSettings>("admin_get_environment"),
    updateEnvironment: (patch: Partial<EnvironmentSettings>) =>
      rpc<EnvironmentSettings>("admin_update_environment", { p_patch: patch }),
    resetEnvironment: () => rpc<EnvironmentSettings>("admin_reset_environment"),
    products: () => rpc<AdminProduct[]>("admin_list_products"),
    updateProduct: (code: string, patch: { rate?: number; min_opening_deposit?: number; is_active?: boolean }) =>
      rpc<{ changed: boolean }>("admin_update_product", { p_code: code, p_patch: patch }),
    audit: (f: {
      actor?: string;
      action?: string;
      outcome?: string;
      member?: string;
      from?: string;
      to?: string;
      limit?: number;
      offset?: number;
    }) =>
      rpc<Paged<AuditRow>>("admin_search_audit", {
        p_actor: f.actor || null,
        p_action: f.action || null,
        p_outcome: f.outcome || null,
        p_member_number: f.member || null,
        p_from: f.from || null,
        p_to: f.to || null,
        p_limit: f.limit ?? 50,
        p_offset: f.offset ?? 0,
      }),
    scenarios: () => rpc<TestScenario[]>("admin_get_test_scenarios"),
    resetScenarios: () => rpc<{ openings_reversed: number; funds_returned: number }>("admin_reset_scenarios"),
  },
};
