-- =====================================================================
-- Migration 2 — service helpers (private, SECURITY INVOKER)
--
-- These run inside the SECURITY DEFINER API functions, so current_user is
-- already the table owner. None of them is granted to API roles.
--
-- Error envelope: API functions never RAISE for business outcomes. They set
-- the HTTP status via response.status and return
--   { code, message, details, hint }
-- which supabase-js surfaces as `error`. Because nothing is raised, the
-- transaction commits and audit rows written on the way (denials, misses)
-- are kept.
--   404 RF404 member_not_found / account_not_found / not_found
--   403 RF403 permission_denied            (audited, carries AUD- reference)
--   409 RF409 business rule                (member_ineligible, duplicate_product, …)
--   422 RF422 validation_failed            (details.fields = [{field, message}])
--   428 RF428 step_up_required             (admin actions need a fresh password)
--   401 PT401 session_expired              (raised — nothing to keep)
-- =====================================================================

create or replace function private.today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'America/New_York')::date
$$;

create or replace function private.fail(p_status integer, p_code text, p_message text, p_details jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('response.status', p_status::text, true);
  return jsonb_build_object('code', p_code, 'message', p_message, 'details', coalesce(p_details, '{}'::jsonb), 'hint', null);
end
$$;

create or replace function private.invalid(p_fields jsonb)
returns jsonb
language sql
set search_path = ''
as $$
  select private.fail(422, 'RF422', 'validation_failed', jsonb_build_object('fields', p_fields))
$$;

create or replace function private.field_error(p_field text, p_message text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('field', p_field, 'message', p_message)
$$;

create or replace function private.try_numeric(p_value text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  return p_value::numeric;
exception when others then
  return null;
end
$$;

create or replace function private.display_name(p_first text, p_middle text, p_last text, p_suffix text)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_last || ', ' || p_first || coalesce(' ' || left(p_middle, 1) || '.', '') || coalesce(' ' || p_suffix, '')
$$;

create or replace function private.full_name(p_first text, p_middle text, p_last text, p_suffix text)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_first || coalesce(' ' || left(p_middle, 1) || '.', '') || ' ' || p_last || coalesce(' ' || p_suffix, '')
$$;

create or replace function private.age_on(p_dob date, p_on date)
returns integer
language sql
immutable
set search_path = ''
as $$
  select extract(year from age(p_on, p_dob))::integer
$$;

create or replace function private.role_label(p_role core.staff_role)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_role
    when 'teller' then 'Teller'
    when 'member_service_rep' then 'Member Service Representative'
    when 'branch_manager' then 'Branch Manager'
    when 'compliance_officer' then 'Compliance Officer'
    when 'system_admin' then 'System Administrator'
  end
$$;

-- ---------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------
create or replace function private.audit(
  p_staff core.staff,
  p_action text,
  p_outcome text,
  p_member_id bigint,
  p_account_id bigint,
  p_summary text,
  p_details jsonb default '{}'::jsonb
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into core.audit_log (staff_id, actor_username, actor_name, action, outcome, member_id, account_id, summary, details, workstation)
  values (p_staff.id, p_staff.username, p_staff.full_name, p_action, p_outcome, p_member_id, p_account_id, p_summary,
          coalesce(p_details, '{}'::jsonb), p_staff.workstation)
  returning id into v_id;
  return 'AUD-' || lpad(v_id::text, 8, '0');
end
$$;

-- ---------------------------------------------------------------------
-- Session & authorisation
-- ---------------------------------------------------------------------

-- Resolves the calling staff member. The session must still exist in
-- auth.sessions, so ending a session (sign-out, admin "End session",
-- deactivation) invalidates outstanding access tokens immediately.
create or replace function private.require_staff()
returns core.staff
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_session uuid;
  v_staff core.staff;
begin
  if v_uid is null then
    raise exception using errcode = 'PT401', message = 'session_expired', detail = 'Sign in to continue.';
  end if;

  v_session := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  if v_session is null
     or not exists (select 1 from auth.sessions s where s.id = v_session and s.user_id = v_uid) then
    raise exception using errcode = 'PT401', message = 'session_expired', detail = 'This session has ended. Sign in again to continue.';
  end if;

  select * into v_staff from core.staff where id = v_uid;
  if not found then
    raise exception using errcode = 'PT403', message = 'no_staff_profile', detail = 'This sign-in is not linked to a staff profile.';
  end if;
  if not v_staff.is_active then
    raise exception using errcode = 'PT403', message = 'account_disabled', detail = 'This staff account is disabled. Contact the Help Desk.';
  end if;

  return v_staff;
end
$$;

create or replace function private.has_permission(p_role core.staff_role, p_permission text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from core.role_permissions rp
    where rp.role = p_role and rp.permission_code = p_permission
  )
$$;

-- null when allowed; otherwise records the denial and returns a 403 envelope.
create or replace function private.check_permission(
  p_staff core.staff,
  p_permission text,
  p_member_id bigint default null,
  p_context text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_label text;
  v_ref text;
begin
  if private.has_permission(p_staff.role, p_permission) then
    return null;
  end if;

  select p.label into v_label from core.permissions p where p.code = p_permission;
  v_ref := private.audit(
    p_staff, 'access.denied', 'denied', p_member_id, null,
    'Blocked: ' || coalesce(p_context, coalesce(v_label, p_permission)),
    jsonb_build_object('permission', p_permission, 'role', p_staff.role)
  );
  return private.fail(403, 'RF403', 'permission_denied', jsonb_build_object(
    'permission', p_permission,
    'permission_label', coalesce(v_label, p_permission),
    'role', p_staff.role,
    'role_label', private.role_label(p_staff.role),
    'reference', v_ref,
    'context', p_context
  ));
end
$$;

-- Admin actions need admin.console AND a password confirmation in the last
-- 15 minutes (read from the JWT amr claim, which survives token refresh).
create or replace function private.admin_error(p_staff core.staff)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_err jsonb;
  v_ts bigint;
begin
  v_err := private.check_permission(p_staff, 'admin.console', null, 'Administration');
  if v_err is not null then
    return v_err;
  end if;

  select max((e ->> 'timestamp')::bigint) into v_ts
  from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) e
  where e ->> 'method' = 'password';

  if v_ts is null or to_timestamp(v_ts) < now() - interval '15 minutes' then
    return private.fail(428, 'RF428', 'step_up_required', jsonb_build_object(
      'window_minutes', 15,
      'authenticated_at', case when v_ts is null then null else to_timestamp(v_ts) end
    ));
  end if;
  return null;
end
$$;

-- null when the caller may open this member; otherwise a 404/403 envelope.
create or replace function private.member_access_error(p_staff core.staff, p_member_number text, p_action text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_m core.members;
  v_ref text;
begin
  if p_member_number is null or p_member_number !~ '^[0-9]{7}$' then
    return private.fail(404, 'RF404', 'member_not_found', jsonb_build_object('member_number', p_member_number, 'reason', 'invalid_format'));
  end if;

  select * into v_m from core.members m where m.member_number = p_member_number;
  if not found then
    perform private.audit(p_staff, p_action, 'failed', null, null, 'No member record ' || p_member_number,
      jsonb_build_object('member_number', p_member_number, 'reason', 'not_found'));
    return private.fail(404, 'RF404', 'member_not_found', jsonb_build_object('member_number', p_member_number));
  end if;

  if v_m.is_restricted and not private.has_permission(p_staff.role, 'members.view_restricted') then
    v_ref := private.audit(p_staff, 'access.denied', 'denied', v_m.id, null,
      'Blocked: restricted record ' || v_m.member_number,
      jsonb_build_object('permission', 'members.view_restricted', 'restriction', v_m.restriction_reason, 'attempted', p_action));
    return private.fail(403, 'RF403', 'permission_denied', jsonb_build_object(
      'permission', 'members.view_restricted',
      'permission_label', 'Open restricted records',
      'role', p_staff.role,
      'role_label', private.role_label(p_staff.role),
      'reference', v_ref,
      'context', 'restricted_record',
      'member_number', v_m.member_number,
      'restriction', v_m.restriction_reason
    ));
  end if;

  return null;
end
$$;

-- ---------------------------------------------------------------------
-- JSON shapes
-- ---------------------------------------------------------------------
create or replace function private.member_json(m core.members)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', m.id,
    'member_number', m.member_number,
    'display_name', private.display_name(m.first_name, m.middle_name, m.last_name, m.name_suffix),
    'full_name', private.full_name(m.first_name, m.middle_name, m.last_name, m.name_suffix),
    'first_name', m.first_name,
    'middle_name', m.middle_name,
    'last_name', m.last_name,
    'name_suffix', m.name_suffix,
    'preferred_name', m.preferred_name,
    'date_of_birth', m.date_of_birth,
    'age', private.age_on(m.date_of_birth, private.today()),
    'ssn_last4', m.ssn_last4,
    'status', m.status,
    'membership_type', m.membership_type,
    'member_since', m.member_since,
    'is_restricted', m.is_restricted,
    'restriction_reason', m.restriction_reason,
    'deceased_on', m.deceased_on,
    'closed_on', m.closed_on,
    'updated_at', m.updated_at,
    'contact', jsonb_build_object(
      'email', m.email,
      'phone_mobile', m.phone_mobile,
      'phone_home', m.phone_home,
      'address_line1', m.address_line1,
      'address_line2', m.address_line2,
      'city', m.city,
      'state', m.state,
      'postal_code', m.postal_code,
      'preferred_contact', m.preferred_contact,
      'e_statements', m.e_statements
    ),
    'identity', jsonb_build_object(
      'id_document_type', m.id_document_type,
      'id_document_state', m.id_document_state,
      'id_document_last4', m.id_document_last4,
      'id_document_expires_on', m.id_document_expires_on,
      'kyc_status', m.kyc_status,
      'kyc_verified_on', m.kyc_verified_on,
      'risk_rating', m.risk_rating
    ),
    'employment', jsonb_build_object('employer', m.employer, 'occupation', m.occupation)
  )
$$;

create or replace function private.account_json(a core.accounts, p core.products, p_owner_number text, p_ownership text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id,
    'account_number', p_owner_number || '-' || a.suffix,
    'suffix', a.suffix,
    'owner_member_number', p_owner_number,
    'ownership', p_ownership,
    'product_code', p.code,
    'product_name', p.name,
    'category', p.category,
    'nickname', a.nickname,
    'status', a.status,
    'opened_on', a.opened_on,
    'closed_on', a.closed_on,
    'current_balance', a.current_balance,
    'available_balance', a.available_balance,
    'hold_amount', a.hold_amount,
    'rate', a.rate,
    'term_months', a.term_months,
    'maturity_date', a.maturity_date,
    'maturity_option', a.maturity_option,
    'dividend_disposition', a.dividend_disposition,
    'original_amount', a.original_amount,
    'credit_limit', a.credit_limit,
    'payment_amount', a.payment_amount,
    'next_payment_due', a.next_payment_due,
    'statement_delivery', a.statement_delivery,
    'debit_card_ordered', a.debit_card_ordered,
    'last_activity_on', a.last_activity_on,
    'opened_by_name', a.opened_by_name,
    'parties', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', ap.party_name,
        'member_number', jm.member_number,
        'role', ap.role,
        'relationship', ap.relationship,
        'percent', ap.beneficiary_pct
      ) order by ap.role, ap.id)
      from core.account_parties ap
      left join core.members jm on jm.id = ap.member_id
      where ap.account_id = a.id
    ), '[]'::jsonb)
  )
$$;

create or replace function private.environment_json()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select to_jsonb(e) - 'id' from core.environment_settings e where e.id = 1
$$;

-- Accounts the member owns outright or jointly.
create or replace function private.member_account_ids(p_member_id bigint)
returns table (account_id bigint, ownership text)
language sql
stable
set search_path = ''
as $$
  select a.id, 'primary' from core.accounts a where a.member_id = p_member_id
  union
  select ap.account_id, 'joint'
  from core.account_parties ap
  join core.accounts a on a.id = ap.account_id
  where ap.member_id = p_member_id and ap.role = 'joint' and a.member_id <> p_member_id
$$;

-- Resolves "1234567-S01" to an account the context member can see.
create or replace function private.resolve_account(p_member_id bigint, p_account_number text)
returns bigint
language sql
stable
set search_path = ''
as $$
  select a.id
  from core.accounts a
  join core.members owner on owner.id = a.member_id
  join private.member_account_ids(p_member_id) mine on mine.account_id = a.id
  where upper(p_account_number) = owner.member_number || '-' || a.suffix
$$;

create or replace function private.product_eligibility(p_member core.members, p core.products)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_age integer := private.age_on(p_member.date_of_birth, private.today());
  v_count integer;
  v_next text;
  v_reason text;
begin
  select count(*) into v_count
  from core.accounts a
  where a.member_id = p_member.id and a.product_code = p.code and a.status <> 'closed';

  select c.s into v_next
  from (select p.suffix_prefix || lpad(n::text, 2, '0') as s from generate_series(p.suffix_min, p.suffix_max) n) c
  where not exists (select 1 from core.accounts a where a.member_id = p_member.id and a.suffix = c.s)
  order by c.s
  limit 1;

  v_reason := case
    when not p.is_active then 'Not currently offered'
    when p.min_age is not null and v_age < p.min_age then 'Member must be ' || p.min_age || ' or older'
    when p.max_age is not null and v_age > p.max_age then 'Only for members under ' || (p.max_age + 1)
    when p.max_per_member is not null and v_count >= p.max_per_member then 'Limit of ' || p.max_per_member || ' per member reached'
    when v_next is null then 'No sub-account numbers available'
  end;

  return jsonb_build_object(
    'eligible', v_reason is null,
    'reason', v_reason,
    'existing_count', v_count,
    'next_suffix', v_next
  );
end
$$;

create or replace function private.opening_blockers(p_member core.members)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(x.issue order by x.ord), '[]'::jsonb)
  from (
    select 1 as ord, jsonb_build_object('code', 'member_status', 'message',
      case p_member.status
        when 'dormant' then 'Membership is dormant. Reactivate the membership before opening new sub-accounts.'
        when 'closed' then 'Membership is closed. New sub-accounts can''t be opened on a closed membership.'
        when 'deceased' then 'Member is deceased. New sub-accounts can''t be opened.'
      end) as issue
    where p_member.status <> 'active'
    union all
    select 2, jsonb_build_object('code', 'kyc', 'message',
      case p_member.kyc_status
        when 'pending_review' then 'Identity verification (CIP) is pending review.'
        when 'expired' then 'Identity verification (CIP) has expired. Re-verify the member''s ID before opening accounts.'
        when 'failed' then 'Identity verification (CIP) failed. Refer the member to Compliance.'
      end)
    where p_member.kyc_status <> 'verified'
    union all
    select 3, jsonb_build_object('code', al.alert_type, 'message',
      case al.alert_type
        when 'ofac_review' then 'OFAC screening match is under review. Account opening is blocked until Compliance clears it.'
        when 'legal_hold' then 'A legal hold is in place on this membership. Account opening is blocked.'
      end)
    from core.member_alerts al
    where al.member_id = p_member.id
      and al.resolved_at is null
      and al.alert_type in ('ofac_review', 'legal_hold')
  ) x
$$;

-- Required disclosures for a product (base set + product-specific).
create or replace function private.required_disclosures(p core.products)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['TIS-2026-03', 'FEE-2026-01', 'PRIV-2025-10'] || case when p.disclosure_code is null then '{}'::text[] else array[p.disclosure_code] end
$$;

-- Printable receipt for an opening (confirmation page, idempotent replays).
create or replace function private.opening_receipt(p_confirmation text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'confirmation_number', o.confirmation_number,
    'opened_at', o.opened_at,
    'member', jsonb_build_object(
      'member_number', m.member_number,
      'display_name', private.display_name(m.first_name, m.middle_name, m.last_name, m.name_suffix),
      'full_name', private.full_name(m.first_name, m.middle_name, m.last_name, m.name_suffix)
    ),
    'account', private.account_json(a, p, m.member_number, 'primary'),
    'product', jsonb_build_object('code', p.code, 'name', p.name, 'category', p.category, 'term_months', p.term_months),
    'initial_deposit', o.initial_deposit,
    'funding', jsonb_build_object(
      'method', o.funding_method,
      'check_number', o.check_number,
      'source_account_number', case when fa.id is null then null else fm.member_number || '-' || fa.suffix end,
      'source_product_name', fp.name
    ),
    'signature_method', o.signature_method,
    'disclosures', o.disclosures,
    'compliance', o.compliance,
    'opened_by', jsonb_build_object('name', s.full_name, 'username', s.username, 'workstation', s.workstation),
    'branch', jsonb_build_object('code', b.code, 'name', b.name)
  )
  from core.account_openings o
  join core.members m on m.id = o.member_id
  join core.accounts a on a.id = o.account_id
  join core.products p on p.code = a.product_code
  join core.staff s on s.id = o.opened_by_id
  join core.branches b on b.id = o.branch_id
  left join core.accounts fa on fa.id = o.funding_account_id
  left join core.members fm on fm.id = fa.member_id
  left join core.products fp on fp.code = fa.product_code
  where o.confirmation_number = p_confirmation
$$;
