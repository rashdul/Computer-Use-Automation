// Shapes returned by the database RPC layer (see supabase/migrations).

export type Role = "teller" | "member_service_rep" | "branch_manager" | "compliance_officer" | "system_admin";

export type Permission =
  | "members.search"
  | "members.view"
  | "members.view_sensitive"
  | "members.view_restricted"
  | "notes.create"
  | "accounts.view"
  | "transactions.view"
  | "accounts.open"
  | "audit.view"
  | "admin.console";

export type Scope = "all" | "search" | "member" | "accounts" | "account_opening";

export type InterruptKind =
  | "maintenance_notice"
  | "compliance_attestation"
  | "password_expiry"
  | "printer_offline"
  | "duplicate_session";

export type InterruptTrigger =
  | "random"
  | "sign_in"
  | "member_search"
  | "member_details"
  | "accounts"
  | "open_sub_account"
  | "review";

export interface EnvironmentSettings {
  latency_mode: "off" | "fixed" | "random";
  latency_fixed_ms: number;
  latency_min_ms: number;
  latency_max_ms: number;
  latency_scope: Scope;
  slow_notice_after_ms: number;
  request_timeout_ms: number;
  failure_rate_pct: number;
  failure_scope: Scope;
  interrupts_enabled: boolean;
  interrupt_trigger: InterruptTrigger;
  interrupt_probability_pct: number;
  interrupt_kinds: InterruptKind[];
  interrupt_once_per_session: boolean;
  interrupt_delay_ms: number;
  idle_timeout_minutes: number;
  idle_warning_seconds: number;
  maintenance_banner: string | null;
  updated_at: string;
  updated_by_name: string;
}

export interface SessionContext {
  staff: {
    id: string;
    employee_id: string;
    username: string;
    full_name: string;
    title: string;
    role: Role;
    role_label: string;
    workstation: string;
    last_sign_in_at: string | null;
  };
  branch: { id: number; code: string; name: string };
  branches: { code: string; name: string }[];
  permissions: Permission[];
  environment: EnvironmentSettings;
  server_time: string;
}

export type MemberStatus = "active" | "dormant" | "closed" | "deceased";
export type MembershipType = "individual" | "joint" | "minor" | "business" | "trust";
export type KycStatus = "verified" | "pending_review" | "expired" | "failed";

export interface SearchRow {
  member_number: string;
  display_name: string;
  date_of_birth?: string;
  ssn_last4?: string;
  phone_mobile?: string | null;
  city?: string;
  state?: string;
  status: MemberStatus;
  membership_type: MembershipType;
  branch_code: string;
  member_since?: string;
  is_restricted: boolean;
  restriction_reason: string | null;
  masked: boolean;
}

export interface SearchResult {
  query_type: string;
  total: number;
  limit: number;
  offset: number;
  rows: SearchRow[];
}

export interface RecentMember {
  member_number: string;
  display_name: string;
  status: MemberStatus;
  city: string | null;
  state: string | null;
  is_restricted: boolean;
  last_viewed_at: string;
}

export interface Member {
  id: number;
  member_number: string;
  display_name: string;
  full_name: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  name_suffix: string | null;
  preferred_name: string | null;
  date_of_birth: string;
  age: number;
  ssn_last4: string;
  status: MemberStatus;
  membership_type: MembershipType;
  member_since: string;
  is_restricted: boolean;
  restriction_reason: string | null;
  deceased_on: string | null;
  closed_on: string | null;
  updated_at: string;
  contact: {
    email: string | null;
    phone_mobile: string | null;
    phone_home: string | null;
    address_line1: string;
    address_line2: string | null;
    city: string;
    state: string;
    postal_code: string;
    preferred_contact: "email" | "mobile" | "home_phone" | "mail";
    e_statements: boolean;
  };
  identity: {
    id_document_type: string | null;
    id_document_state: string | null;
    id_document_last4: string | null;
    id_document_expires_on: string | null;
    kyc_status: KycStatus;
    kyc_verified_on: string | null;
    risk_rating: "low" | "moderate" | "high";
  };
  employment: { employer: string | null; occupation: string | null };
}

export type AlertType =
  | "ofac_review"
  | "fraud_alert"
  | "deceased"
  | "address_undeliverable"
  | "id_expired"
  | "bankruptcy"
  | "legal_hold"
  | "do_not_contact";

export interface MemberAlert {
  id: number;
  type: AlertType;
  severity: "info" | "warning" | "critical";
  message: string;
  created_at: string;
  created_by: string;
}

export interface Note {
  id: number;
  category: NoteCategory;
  body: string;
  author_name: string;
  created_at: string;
  is_pinned: boolean;
}

export type NoteCategory = "Service" | "Account maintenance" | "Fraud" | "Collections" | "Complaint" | "Compliance";

export interface MemberDetail {
  member: Member;
  branch: { code: string; name: string };
  alerts: MemberAlert[];
  relationships: {
    member_number: string;
    display_name: string;
    relationship: string;
    status: MemberStatus;
    is_restricted: boolean;
  }[];
  summary: {
    open_accounts: number;
    joint_accounts: number;
    deposit_total: number;
    available_total: number;
    loan_total: number;
    last_activity_on: string | null;
  };
  recent_notes: Note[];
  notes_count: number;
  capabilities: {
    reveal_ssn: boolean;
    view_accounts: boolean;
    view_transactions: boolean;
    open_accounts: boolean;
    add_notes: boolean;
    view_access_log: boolean;
  };
}

export type ProductCategory = "share" | "share_draft" | "money_market" | "club" | "certificate" | "ira" | "loan";
export type AccountStatus = "open" | "dormant" | "restricted" | "closed";

export interface AccountParty {
  name: string;
  member_number: string | null;
  role: "joint" | "beneficiary" | "authorized_signer" | "custodian";
  relationship: string | null;
  percent: number | null;
}

export interface Account {
  id: number;
  account_number: string;
  suffix: string;
  owner_member_number: string;
  ownership: "primary" | "joint";
  product_code: string;
  product_name: string;
  category: ProductCategory;
  nickname: string | null;
  status: AccountStatus;
  opened_on: string;
  closed_on: string | null;
  current_balance: number;
  available_balance: number;
  hold_amount: number;
  rate: number | null;
  term_months: number | null;
  maturity_date: string | null;
  maturity_option: "renew" | "transfer_to_share" | "mail_check" | null;
  dividend_disposition: "compound" | "transfer_to_share" | null;
  original_amount: number | null;
  credit_limit: number | null;
  payment_amount: number | null;
  next_payment_due: string | null;
  statement_delivery: "electronic" | "paper";
  debit_card_ordered: boolean | null;
  last_activity_on: string | null;
  opened_by_name: string;
  parties: AccountParty[];
}

export interface MemberAccounts {
  member_number: string;
  accounts: Account[];
  closed_count: number;
}

export interface AccountDetail {
  account: Account;
  product: {
    code: string;
    name: string;
    category: ProductCategory;
    description: string;
    min_balance: number;
    monthly_fee: number;
    term_months: number | null;
  };
  owner: { member_number: string; display_name: string };
  opening: { confirmation_number: string; opened_at: string; opened_by: string } | null;
  overdraft_source_account_number: string | null;
  history_starts_on: string | null;
}

export interface Transaction {
  id: number;
  posted_at: string;
  amount: number;
  balance_after: number;
  type: string;
  channel: string;
  status: "posted" | "pending";
  description: string;
  reference: string | null;
}

export interface TransactionPage {
  account_number: string;
  total: number;
  limit: number;
  offset: number;
  balance_forward: number | null;
  rows: Transaction[];
}

export interface Product {
  code: string;
  name: string;
  category: ProductCategory;
  description: string;
  min_opening_deposit: number;
  min_balance: number;
  rate: number | null;
  term_months: number | null;
  max_per_member: number | null;
  min_age?: number | null;
  max_age?: number | null;
  monthly_fee: number;
  is_openable?: boolean;
  updated_at?: string;
}

export interface OpenContextProduct extends Product {
  disclosures: string[];
  eligibility: { eligible: boolean; reason: string | null; existing_count: number; next_suffix: string | null };
}

export interface OpenContext {
  member: {
    member_number: string;
    display_name: string;
    full_name: string;
    age: number;
    status: MemberStatus;
    membership_type: MembershipType;
    kyc_status: KycStatus;
    has_email: boolean;
    email_masked: string | null;
    mailing_address: string;
  };
  blockers: { code: string; message: string }[];
  screening: { ofac: "clear" | "review_required"; cip: KycStatus; screened_at: string };
  products: OpenContextProduct[];
  funding_accounts: {
    account_number: string;
    suffix: string;
    product_name: string;
    category: ProductCategory;
    nickname: string | null;
    ownership: "primary" | "joint";
    available_balance: number;
    min_balance: number;
    transferable: number;
  }[];
  joint_candidates: {
    member_number: string;
    display_name: string;
    relationship: string;
    eligible: boolean;
    reason: string | null;
  }[];
  disclosure_catalog: { code: string; title: string; revised: string }[];
}

export interface MemberBrief {
  member_number: string;
  display_name: string;
  status?: MemberStatus;
  eligible: boolean;
  reason: string | null;
}

export interface OpenAccountRequest {
  client_request_id: string;
  member_number: string;
  product_code: string;
  nickname: string;
  ownership: { type: "individual" | "joint"; joint_member_numbers: string[] };
  beneficiaries: { name: string; relationship: string; percent: string }[];
  funding: {
    method: "transfer" | "cash" | "check" | "none";
    amount: string;
    source_account_number: string;
    check_number: string;
  };
  certificate: { maturity_option: string; dividend_disposition: string };
  checking: { overdraft_source_account_number: string; order_debit_card: boolean };
  statement_delivery: "electronic" | "paper";
  compliance: { purpose: string; expected_monthly_deposits: string; source_of_funds: string };
  disclosures_acknowledged: string[];
  signature_method: string;
  confirm_duplicate_product: boolean;
}

export interface OpeningReceipt {
  confirmation_number: string;
  opened_at: string;
  member: { member_number: string; display_name: string; full_name: string };
  account: Account;
  product: { code: string; name: string; category: ProductCategory; term_months: number | null };
  initial_deposit: number;
  funding: {
    method: "transfer" | "cash" | "check" | "none";
    check_number: string | null;
    source_account_number: string | null;
    source_product_name: string | null;
  };
  signature_method: "signature_pad" | "wet_signature" | "e_sign";
  disclosures: string[];
  compliance: { purpose: string; expected_monthly_deposits: string; source_of_funds: string; ofac: string; cip: string };
  opened_by: { name: string; username: string; workstation: string };
  branch: { code: string; name: string };
  idempotent_replay?: boolean;
}

export interface AuditRow {
  reference: string;
  occurred_at: string;
  actor_name?: string;
  actor_username?: string;
  action: string;
  outcome: "success" | "denied" | "failed";
  summary: string;
  member_number?: string | null;
  workstation?: string | null;
  details?: Record<string, unknown>;
}

export interface Paged<T> {
  total: number;
  rows: T[];
  limit?: number;
  offset?: number;
}

// ---- Administration ----------------------------------------------------------
export interface AdminOverview {
  counts: {
    members: number;
    active_members: number;
    restricted_members: number;
    accounts: number;
    open_accounts: number;
    transactions_estimate: number;
    audit_events_estimate: number;
    notes: number;
    staff: number;
    active_staff: number;
    active_sessions: number;
  };
  balances: { deposits: number; loans: number };
  today: { accounts_opened: number; member_views: number; access_denied: number; sign_ins: number };
  database_bytes: number;
  environment: EnvironmentSettings;
  recent_admin_events: { reference: string; occurred_at: string; actor_name: string; action: string; summary: string }[];
}

export interface StaffRow {
  id: string;
  employee_id: string;
  username: string;
  full_name: string;
  title: string;
  role: Role;
  role_label: string;
  branch_code: string;
  branch_name: string;
  workstation: string;
  is_active: boolean;
  last_sign_in_at: string | null;
  active_sessions: number;
  is_you: boolean;
}

export interface SessionRow {
  session_id: string;
  staff_id: string;
  full_name: string;
  username: string;
  role_label: string;
  workstation: string;
  started_at: string;
  last_active_at: string;
  user_agent: string | null;
  is_current: boolean;
}

export interface PermissionMatrix {
  roles: { role: Role; label: string; staff_count: number }[];
  permissions: {
    code: Permission;
    label: string;
    description: string;
    category: string;
    granted_to: Role[];
  }[];
}

export interface AdminProduct extends Product {
  is_active: boolean;
  open_accounts: number;
}

export interface TestScenario {
  key: string;
  title: string;
  description: string;
  member_number: string | null;
  sign_in_as: string | null;
  expected_outcome: string;
  sort_order: number;
}
