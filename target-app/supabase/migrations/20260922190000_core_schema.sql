-- =====================================================================
-- Rashed Federal Credit Union · Member Services Console
-- Migration 1 — system-of-record schema
--
-- Layout
--   core     tables of record (members, accounts, ledger, staff, audit).
--            NOT exposed through the Data API; only private.* functions
--            touch it.
--   private  SECURITY DEFINER service logic (not exposed).
--   public   thin SECURITY INVOKER RPC wrappers — the only API surface.
-- =====================================================================

create extension if not exists pg_trgm with schema extensions;

-- New objects in public are not reachable through the Data API unless a
-- migration grants them explicitly (matches Supabase's 2026 default).
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

create schema if not exists core;
revoke all on schema core from public, anon, authenticated;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
alter default privileges for role postgres in schema private revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Domain types
-- ---------------------------------------------------------------------
create type core.staff_role as enum ('teller', 'member_service_rep', 'branch_manager', 'compliance_officer', 'system_admin');
create type core.member_status as enum ('active', 'dormant', 'closed', 'deceased');
create type core.membership_type as enum ('individual', 'joint', 'minor', 'business', 'trust');
create type core.kyc_status as enum ('verified', 'pending_review', 'expired', 'failed');
create type core.risk_rating as enum ('low', 'moderate', 'high');
create type core.product_category as enum ('share', 'share_draft', 'money_market', 'club', 'certificate', 'ira', 'loan');
create type core.account_status as enum ('open', 'dormant', 'restricted', 'closed');
create type core.party_role as enum ('joint', 'beneficiary', 'authorized_signer', 'custodian');
create type core.txn_type as enum (
  'deposit', 'withdrawal', 'transfer_in', 'transfer_out', 'dividend', 'fee',
  'ach_credit', 'ach_debit', 'card_purchase', 'atm_withdrawal', 'check_paid',
  'check_deposit', 'loan_disbursement', 'loan_payment', 'interest_charge', 'adjustment'
);
create type core.txn_channel as enum ('branch', 'atm', 'online', 'mobile', 'ach', 'card', 'system');
create type core.txn_status as enum ('posted', 'pending');
create type core.alert_type as enum (
  'ofac_review', 'fraud_alert', 'deceased', 'address_undeliverable',
  'id_expired', 'bankruptcy', 'legal_hold', 'do_not_contact'
);
create type core.alert_severity as enum ('info', 'warning', 'critical');

-- ---------------------------------------------------------------------
-- Organisation & staff
-- ---------------------------------------------------------------------
create table core.branches (
  id            smallint primary key,
  code          text not null unique,
  name          text not null,
  address_line1 text not null,
  city          text not null,
  state         char(2) not null,
  postal_code   text not null,
  phone         text not null,
  opened_on     date not null
);

create table core.staff (
  id              uuid primary key references auth.users (id) on delete cascade,
  employee_id     text not null unique,
  username        text not null unique check (username ~ '^[a-z][a-z0-9.]{2,31}$'),
  full_name       text not null,
  title           text not null,
  role            core.staff_role not null,
  branch_id       smallint not null references core.branches (id),
  workstation     text not null,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  last_sign_in_at timestamptz
);
create index staff_branch_idx on core.staff (branch_id);

create table core.permissions (
  code        text primary key,
  label       text not null,
  description text not null,
  category    text not null,
  sort_order  smallint not null
);

create table core.role_permissions (
  role            core.staff_role not null,
  permission_code text not null references core.permissions (code) on delete cascade,
  granted_at      timestamptz not null default now(),
  primary key (role, permission_code)
);
create index role_permissions_permission_idx on core.role_permissions (permission_code);

-- ---------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------
create table core.members (
  id                     bigint generated always as identity primary key,
  member_number          text not null unique check (member_number ~ '^[0-9]{7}$'),
  first_name             text not null,
  middle_name            text,
  last_name              text not null,
  name_suffix            text,
  preferred_name         text,
  date_of_birth          date not null,
  ssn                    text not null check (ssn ~ '^9[0-9]{8}$'),   -- synthetic: 9xx area is never issued
  ssn_last4              text generated always as (right(ssn, 4)) stored,
  search_name            text generated always as (lower(first_name || ' ' || coalesce(middle_name || ' ', '') || last_name)) stored,
  email                  text,
  phone_mobile           text check (phone_mobile ~ '^[0-9]{10}$'),
  phone_home             text check (phone_home ~ '^[0-9]{10}$'),
  address_line1          text not null,
  address_line2          text,
  city                   text not null,
  state                  char(2) not null,
  postal_code            text not null,
  member_since           date not null,
  status                 core.member_status not null default 'active',
  membership_type        core.membership_type not null default 'individual',
  primary_branch_id      smallint not null references core.branches (id),
  employer               text,
  occupation             text,
  id_document_type       text,
  id_document_state      char(2),
  id_document_last4      text,
  id_document_expires_on date,
  kyc_status             core.kyc_status not null default 'verified',
  kyc_verified_on        date,
  risk_rating            core.risk_rating not null default 'low',
  is_restricted          boolean not null default false,
  restriction_reason     text,
  e_statements           boolean not null default true,
  preferred_contact      text not null default 'email' check (preferred_contact in ('email', 'mobile', 'home_phone', 'mail')),
  deceased_on            date,
  closed_on              date,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint members_restricted_reason check (not is_restricted or restriction_reason is not null)
);
create index members_name_trgm_idx on core.members using gin (search_name extensions.gin_trgm_ops);
create index members_last_name_idx on core.members (lower(last_name) text_pattern_ops, lower(first_name));
create index members_ssn_last4_idx on core.members (ssn_last4);
create index members_ssn_idx on core.members (ssn);
create index members_phone_mobile_idx on core.members (phone_mobile);
create index members_email_idx on core.members (lower(email));
create index members_branch_status_idx on core.members (primary_branch_id, status);

create table core.member_relationships (
  id                bigint generated always as identity primary key,
  member_id         bigint not null references core.members (id) on delete cascade,
  related_member_id bigint not null references core.members (id) on delete cascade,
  relationship      text not null,
  created_at        timestamptz not null default now(),
  unique (member_id, related_member_id),
  check (member_id <> related_member_id)
);
create index member_relationships_related_idx on core.member_relationships (related_member_id);

create table core.member_alerts (
  id              bigint generated always as identity primary key,
  member_id       bigint not null references core.members (id) on delete cascade,
  alert_type      core.alert_type not null,
  severity        core.alert_severity not null,
  message         text not null,
  created_at      timestamptz not null default now(),
  created_by_name text not null default 'System',
  resolved_at     timestamptz
);
create index member_alerts_open_idx on core.member_alerts (member_id) where resolved_at is null;

create table core.member_notes (
  id          bigint generated always as identity primary key,
  member_id   bigint not null references core.members (id) on delete cascade,
  author_id   uuid references core.staff (id) on delete set null,
  author_name text not null,
  category    text not null check (category in ('Service', 'Account maintenance', 'Fraud', 'Collections', 'Complaint', 'Compliance')),
  body        text not null check (length(body) between 1 and 2000),
  is_pinned   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index member_notes_member_idx on core.member_notes (member_id, created_at desc);
create index member_notes_author_idx on core.member_notes (author_id);

-- ---------------------------------------------------------------------
-- Products & accounts
-- ---------------------------------------------------------------------
create table core.products (
  code                text primary key,
  name                text not null,
  category            core.product_category not null,
  suffix_prefix       char(1) not null,
  suffix_min          smallint not null,
  suffix_max          smallint not null,
  description         text not null,
  min_opening_deposit numeric(12, 2) not null default 0,
  min_balance         numeric(12, 2) not null default 0,
  rate                numeric(6, 3),               -- APY for deposits, APR for loans
  term_months         smallint,
  max_per_member      smallint,
  min_age             smallint,
  max_age             smallint,
  monthly_fee         numeric(8, 2) not null default 0,
  is_openable         boolean not null default true,  -- false: opened by other systems (loans, S00)
  is_active           boolean not null default true,
  disclosure_code     text,
  sort_order          smallint not null,
  updated_at          timestamptz not null default now(),
  check (suffix_min <= suffix_max)
);

create table core.accounts (
  id                          bigint generated always as identity primary key,
  member_id                   bigint not null references core.members (id),
  suffix                      text not null check (suffix ~ '^[A-Z][0-9]{2}$'),
  product_code                text not null references core.products (code),
  nickname                    text check (length(nickname) <= 30),
  status                      core.account_status not null default 'open',
  opened_on                   date not null,
  closed_on                   date,
  current_balance             numeric(14, 2) not null default 0,
  available_balance           numeric(14, 2) not null default 0,
  hold_amount                 numeric(14, 2) not null default 0,
  rate                        numeric(6, 3),
  term_months                 smallint,
  maturity_date               date,
  maturity_option             text check (maturity_option in ('renew', 'transfer_to_share', 'mail_check')),
  dividend_disposition        text check (dividend_disposition in ('compound', 'transfer_to_share')),
  original_amount             numeric(14, 2),
  credit_limit                numeric(14, 2),
  payment_amount              numeric(12, 2),
  next_payment_due            date,
  statement_delivery          text not null default 'electronic' check (statement_delivery in ('electronic', 'paper')),
  overdraft_source_account_id bigint references core.accounts (id),
  debit_card_ordered          boolean,
  opened_by_id                uuid references core.staff (id) on delete set null,
  opened_by_name              text not null,
  branch_id                   smallint not null references core.branches (id),
  last_activity_on            date,
  created_at                  timestamptz not null default now(),
  unique (member_id, suffix)
);
create index accounts_product_idx on core.accounts (product_code);
create index accounts_overdraft_source_idx on core.accounts (overdraft_source_account_id) where overdraft_source_account_id is not null;
create index accounts_opened_by_idx on core.accounts (opened_by_id) where opened_by_id is not null;
create index accounts_branch_idx on core.accounts (branch_id);

-- Joint owners, POD beneficiaries, signers. The primary owner is accounts.member_id.
create table core.account_parties (
  id              bigint generated always as identity primary key,
  account_id      bigint not null references core.accounts (id) on delete cascade,
  member_id       bigint references core.members (id),
  party_name      text not null,
  role            core.party_role not null,
  relationship    text,
  beneficiary_pct numeric(5, 2) check (beneficiary_pct > 0 and beneficiary_pct <= 100),
  added_on        date not null,
  check (role <> 'beneficiary' or beneficiary_pct is not null)
);
create index account_parties_account_idx on core.account_parties (account_id);
create index account_parties_member_idx on core.account_parties (member_id) where member_id is not null;

-- Posted ledger. amount is signed from the account's point of view:
-- deposits (+) / withdrawals (−); for loans, disbursements & interest (+), payments (−).
create table core.transactions (
  id            bigint generated always as identity primary key,
  account_id    bigint not null references core.accounts (id),
  posted_at     timestamptz not null,
  amount        numeric(14, 2) not null check (amount <> 0),
  balance_after numeric(14, 2) not null,
  txn_type      core.txn_type not null,
  channel       core.txn_channel not null,
  status        core.txn_status not null default 'posted',
  description   text not null,
  reference     text
);
create index transactions_account_posted_idx on core.transactions (account_id, posted_at desc, id desc);

-- One row per sub-account opened through this console (idempotent by client_request_id).
create table core.account_openings (
  id                  bigint generated always as identity primary key,
  confirmation_number text not null unique,
  client_request_id   uuid not null unique,
  member_id           bigint not null references core.members (id),
  account_id          bigint not null references core.accounts (id),
  product_code        text not null references core.products (code),
  initial_deposit     numeric(14, 2) not null,
  funding_method      text not null check (funding_method in ('transfer', 'cash', 'check', 'none')),
  funding_account_id  bigint references core.accounts (id),
  check_number        text,
  signature_method    text not null check (signature_method in ('signature_pad', 'wet_signature', 'e_sign')),
  disclosures         jsonb not null,
  compliance          jsonb not null,
  opened_by_id        uuid not null references core.staff (id),
  opened_at           timestamptz not null default now(),
  branch_id           smallint not null references core.branches (id)
);
create index account_openings_member_idx on core.account_openings (member_id);
create index account_openings_account_idx on core.account_openings (account_id);
create index account_openings_funding_idx on core.account_openings (funding_account_id) where funding_account_id is not null;
create index account_openings_staff_idx on core.account_openings (opened_by_id);
create index account_openings_product_idx on core.account_openings (product_code);
create index account_openings_branch_idx on core.account_openings (branch_id);

-- ---------------------------------------------------------------------
-- Audit trail (append-only by convention; references are AUD-<id>)
-- ---------------------------------------------------------------------
create table core.audit_log (
  id             bigint generated always as identity primary key,
  occurred_at    timestamptz not null default now(),
  staff_id       uuid references core.staff (id) on delete set null,
  actor_username text not null,
  actor_name     text not null,
  action         text not null,
  outcome        text not null default 'success' check (outcome in ('success', 'denied', 'failed')),
  member_id      bigint references core.members (id) on delete set null,
  account_id     bigint references core.accounts (id) on delete set null,
  summary        text not null,
  details        jsonb not null default '{}'::jsonb,
  workstation    text
);
create index audit_log_occurred_idx on core.audit_log (occurred_at desc);
create index audit_log_staff_idx on core.audit_log (staff_id, occurred_at desc);
create index audit_log_member_idx on core.audit_log (member_id, occurred_at desc) where member_id is not null;
create index audit_log_account_idx on core.audit_log (account_id) where account_id is not null;
create index audit_log_action_idx on core.audit_log (action, occurred_at desc);

-- ---------------------------------------------------------------------
-- UAT environment controls (single row) and the test-data catalogue
-- ---------------------------------------------------------------------
create table core.environment_settings (
  id                        smallint primary key default 1 check (id = 1),
  latency_mode              text not null default 'off' check (latency_mode in ('off', 'fixed', 'random')),
  latency_fixed_ms          integer not null default 2500 check (latency_fixed_ms between 0 and 30000),
  latency_min_ms            integer not null default 800 check (latency_min_ms between 0 and 30000),
  latency_max_ms            integer not null default 4000 check (latency_max_ms between 0 and 30000),
  latency_scope             text not null default 'all' check (latency_scope in ('all', 'search', 'member', 'accounts', 'account_opening')),
  slow_notice_after_ms      integer not null default 3000 check (slow_notice_after_ms between 500 and 30000),
  request_timeout_ms        integer not null default 15000 check (request_timeout_ms between 3000 and 60000),
  failure_rate_pct          smallint not null default 0 check (failure_rate_pct between 0 and 100),
  failure_scope             text not null default 'all' check (failure_scope in ('all', 'search', 'member', 'accounts', 'account_opening')),
  interrupts_enabled        boolean not null default false,
  interrupt_trigger         text not null default 'random' check (interrupt_trigger in ('random', 'sign_in', 'member_search', 'member_details', 'accounts', 'open_sub_account', 'review')),
  interrupt_probability_pct smallint not null default 30 check (interrupt_probability_pct between 0 and 100),
  interrupt_kinds           text[] not null default array['maintenance_notice', 'compliance_attestation', 'password_expiry', 'printer_offline', 'duplicate_session'],
  interrupt_once_per_session boolean not null default true,
  interrupt_delay_ms        integer not null default 900 check (interrupt_delay_ms between 0 and 10000),
  idle_timeout_minutes      smallint not null default 15 check (idle_timeout_minutes between 1 and 120),
  idle_warning_seconds      smallint not null default 60 check (idle_warning_seconds between 10 and 300),
  maintenance_banner        text check (length(maintenance_banner) <= 200),
  updated_at                timestamptz not null default now(),
  updated_by_name           text not null default 'System',
  check (latency_min_ms <= latency_max_ms),
  check (idle_warning_seconds < idle_timeout_minutes * 60),
  check (interrupt_kinds <@ array['maintenance_notice', 'compliance_attestation', 'password_expiry', 'printer_offline', 'duplicate_session'])
);
insert into core.environment_settings (id) values (1);

create table core.test_scenarios (
  key              text primary key,
  title            text not null,
  description      text not null,
  member_number    text,
  sign_in_as       text,
  expected_outcome text not null,
  sort_order       smallint not null
);

-- Defense in depth: RLS on every table, no policies. Only the table owner
-- (postgres, via private.* SECURITY DEFINER functions) can read or write.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'core' loop
    execute format('alter table core.%I enable row level security', t.tablename);
    execute format('revoke all on core.%I from public, anon, authenticated', t.tablename);
  end loop;
end $$;
