export type ApiErrorKind =
  | "not_found"
  | "permission_denied"
  | "validation"
  | "conflict"
  | "step_up_required"
  | "session_expired"
  | "account_disabled"
  | "timeout"
  | "unavailable"
  | "network"
  | "server";

export interface FieldError {
  field: string;
  message: string;
}

export interface PermissionDetails {
  permission?: string;
  permission_label?: string;
  role?: string;
  role_label?: string;
  reference?: string;
  context?: string | null;
  member_number?: string;
  restriction?: string | null;
}

interface ApiErrorInit {
  kind: ApiErrorKind;
  message: string;
  status?: number;
  code?: string;
  details?: unknown;
  reference?: string;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly reference: string | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = "ApiError";
    this.kind = init.kind;
    this.status = init.status ?? 0;
    this.code = init.code ?? "";
    this.details = init.details;
    this.reference = init.reference;
  }

  get fields(): FieldError[] {
    const d = this.details as { fields?: FieldError[] } | undefined;
    return Array.isArray(d?.fields) ? d!.fields : [];
  }

  get permission(): PermissionDetails {
    return (this.details ?? {}) as PermissionDetails;
  }

  /** Business-rule code for 409s, e.g. "member_ineligible", "duplicate_product". */
  get rule(): string {
    return this.message;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export function makeReference(prefix: string): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${prefix}-${out}`;
}

/** Error kinds that belong to a whole page rather than an inline message. */
export function isPageLevel(e: unknown): boolean {
  return isApiError(e) && (e.kind === "not_found" || e.kind === "permission_denied");
}
