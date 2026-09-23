-- =====================================================================
-- Migration 3 — member & account API (private SECURITY DEFINER)
-- Public SECURITY INVOKER wrappers and grants are in migration 5.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Session
-- ---------------------------------------------------------------------
create or replace function private.get_session_context()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_branch core.branches;
begin
  select * into v_branch from core.branches where id = v_staff.branch_id;
  return jsonb_build_object(
    'staff', jsonb_build_object(
      'id', v_staff.id,
      'employee_id', v_staff.employee_id,
      'username', v_staff.username,
      'full_name', v_staff.full_name,
      'title', v_staff.title,
      'role', v_staff.role,
      'role_label', private.role_label(v_staff.role),
      'workstation', v_staff.workstation,
      'last_sign_in_at', v_staff.last_sign_in_at
    ),
    'branch', jsonb_build_object('id', v_branch.id, 'code', v_branch.code, 'name', v_branch.name),
    'permissions', coalesce((
      select jsonb_agg(rp.permission_code order by rp.permission_code)
      from core.role_permissions rp where rp.role = v_staff.role
    ), '[]'::jsonb),
    'branches', (
      select jsonb_agg(jsonb_build_object('code', b.code, 'name', b.name) order by b.id)
      from core.branches b
    ),
    'environment', private.environment_json(),
    'server_time', now()
  );
end
$$;

create or replace function private.session_heartbeat()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
begin
  return jsonb_build_object(
    'server_time', now(),
    'environment', private.environment_json(),
    'permissions', coalesce((
      select jsonb_agg(rp.permission_code order by rp.permission_code)
      from core.role_permissions rp where rp.role = v_staff.role
    ), '[]'::jsonb)
  );
end
$$;

create or replace function private.record_auth_event(p_event text, p_details jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff;
begin
  if p_event is null or p_event not in ('sign_in', 'sign_out', 'idle_timeout', 'step_up') then
    return private.invalid(jsonb_build_array(private.field_error('event', 'Unknown authentication event.')));
  end if;
  v_staff := private.require_staff();
  if p_event = 'sign_in' then
    update core.staff set last_sign_in_at = now() where id = v_staff.id;
  end if;
  perform private.audit(v_staff, 'auth.' || p_event, 'success', null, null,
    case p_event
      when 'sign_in' then 'Signed in'
      when 'sign_out' then 'Signed out'
      when 'idle_timeout' then 'Session ended after inactivity'
      when 'step_up' then 'Confirmed password for Administration'
    end,
    coalesce(p_details, '{}'::jsonb) - 'password');
  return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------------
-- Member search
-- ---------------------------------------------------------------------
create or replace function private.search_members(
  p_query text,
  p_status text default null,
  p_branch text default null,
  p_sort text default 'relevance',
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb;
  v_q text := btrim(coalesce(p_query, ''));
  v_digits text;
  v_kind text;
  v_tokens text[];
  v_first_token text;
  v_branch_id smallint;
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_sort text := coalesce(nullif(p_sort, ''), 'relevance');
  v_can_restricted boolean;
  v_ids bigint[];
  v_total integer;
  v_rows jsonb;
begin
  v_err := private.check_permission(v_staff, 'members.search', null, 'Member search');
  if v_err is not null then
    return v_err;
  end if;

  if length(v_q) < 2 then
    return private.invalid(jsonb_build_array(private.field_error('query', 'Enter at least 2 characters to search.')));
  end if;
  if p_status is not null and p_status not in ('active', 'dormant', 'closed', 'deceased') then
    return private.invalid(jsonb_build_array(private.field_error('status', 'Unknown membership status.')));
  end if;
  if v_sort not in ('relevance', 'name', 'member_number', 'member_since') then
    return private.invalid(jsonb_build_array(private.field_error('sort', 'Unknown sort order.')));
  end if;
  if p_branch is not null then
    select b.id into v_branch_id from core.branches b where b.code = p_branch;
    if v_branch_id is null then
      return private.invalid(jsonb_build_array(private.field_error('branch', 'Unknown branch.')));
    end if;
  end if;

  v_digits := regexp_replace(v_q, '[^0-9]', '', 'g');
  v_kind := case
    when v_q ~ '^[0-9]{7}$' then 'member_number'
    when v_q ~* '^[0-9]{7}-?[a-z][0-9]{2}$' then 'account_number'
    when v_q ~ '^[0-9]{3}-?[0-9]{2}-?[0-9]{4}$' then 'ssn'
    when v_q ~ '^[0-9]{4}$' then 'ssn_last4'
    when v_q ~ '^\(?[0-9]{3}\)?[-. ]?[0-9]{3}[-. ]?[0-9]{4}$' then 'phone'
    when position('@' in v_q) > 0 then 'email'
    when v_q ~ '[0-9]' then 'unrecognized'
    else 'name'
  end;

  if v_kind = 'unrecognized' then
    return private.invalid(jsonb_build_array(private.field_error('query',
      case when v_q ~ '^[0-9]{5,6}$'
        then 'Member numbers are 7 digits. Check the number and try again.'
        else 'Search by name, 7-digit member number, SSN (last 4 or all 9 digits), phone, or email.'
      end)));
  end if;

  if v_kind = 'name' then
    v_tokens := array(
      select t
      from regexp_split_to_table(lower(regexp_replace(v_q, '[^A-Za-z'' -]', ' ', 'g')), '[ ,]+') t
      where length(t) > 0
      limit 4
    );
    if coalesce(array_length(v_tokens, 1), 0) = 0 then
      return private.invalid(jsonb_build_array(private.field_error('query', 'Enter a name to search.')));
    end if;
    -- the longest token drives the trigram index; the rest filter
    select t into v_first_token from unnest(v_tokens) t order by length(t) desc limit 1;
  end if;

  v_can_restricted := private.has_permission(v_staff.role, 'members.view_restricted');

  with matched as (
    select m.id, m.last_name, m.first_name, m.member_number, m.member_since,
      case
        when v_kind <> 'name' then 0
        when lower(m.last_name) = any (v_tokens) and lower(m.first_name) = any (v_tokens) then 0
        when lower(m.last_name) = any (v_tokens) then 1
        when lower(m.first_name) = any (v_tokens) then 2
        else 3
      end as rank
    from core.members m
    where (
        (v_kind = 'member_number' and m.member_number = v_q)
        or (v_kind = 'account_number' and m.member_number = left(v_digits, 7))
        or (v_kind = 'ssn' and m.ssn = v_digits)
        or (v_kind = 'ssn_last4' and m.ssn_last4 = v_q)
        or (v_kind = 'phone' and (m.phone_mobile = right(v_digits, 10) or m.phone_home = right(v_digits, 10)))
        or (v_kind = 'email' and lower(m.email) = lower(v_q))
        or (v_kind = 'name'
            and m.search_name like '%' || v_first_token || '%'
            and not exists (select 1 from unnest(v_tokens) t where m.search_name not like '%' || t || '%'))
      )
      and (p_status is null or m.status = p_status::core.member_status)
      and (v_branch_id is null or m.primary_branch_id = v_branch_id)
  )
  select count(*)::integer,
         (array_agg(id order by
            case when v_sort = 'relevance' then rank end,
            case when v_sort in ('relevance', 'name') then lower(last_name) end,
            case when v_sort in ('relevance', 'name') then lower(first_name) end,
            case when v_sort = 'member_since' then member_since end desc,
            member_number))[v_offset + 1 : v_offset + v_limit]
    into v_total, v_ids
  from matched;

  select coalesce(jsonb_agg(
    case when m.is_restricted and not v_can_restricted then
      jsonb_build_object(
        'member_number', m.member_number,
        'display_name', private.display_name(m.first_name, m.middle_name, m.last_name, m.name_suffix),
        'status', m.status,
        'membership_type', m.membership_type,
        'branch_code', b.code,
        'is_restricted', true,
        'restriction_reason', m.restriction_reason,
        'masked', true
      )
    else
      jsonb_build_object(
        'member_number', m.member_number,
        'display_name', private.display_name(m.first_name, m.middle_name, m.last_name, m.name_suffix),
        'date_of_birth', m.date_of_birth,
        'ssn_last4', m.ssn_last4,
        'phone_mobile', m.phone_mobile,
        'city', m.city,
        'state', m.state,
        'status', m.status,
        'membership_type', m.membership_type,
        'branch_code', b.code,
        'member_since', m.member_since,
        'is_restricted', m.is_restricted,
        'restriction_reason', m.restriction_reason,
        'masked', false
      )
    end
    order by array_position(v_ids, m.id)), '[]'::jsonb)
    into v_rows
  from core.members m
  join core.branches b on b.id = m.primary_branch_id
  where m.id = any (coalesce(v_ids, '{}'::bigint[]));

  -- the raw query can itself be PII (SSN, phone); record only its shape
  perform private.audit(v_staff, 'member.search', 'success', null, null,
    'Searched members by ' || replace(v_kind, '_', ' ') || ' (' || v_total || ' result' || case when v_total = 1 then '' else 's' end || ')',
    jsonb_build_object('query_type', v_kind, 'result_count', v_total, 'status', p_status, 'branch', p_branch));

  return jsonb_build_object(
    'query_type', v_kind,
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'rows', v_rows
  );
end
$$;

create or replace function private.get_recent_members()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_can_restricted boolean := private.has_permission(v_staff.role, 'members.view_restricted');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'member_number', m.member_number,
      'display_name', private.display_name(m.first_name, m.middle_name, m.last_name, m.name_suffix),
      'status', m.status,
      'city', case when m.is_restricted and not v_can_restricted then null else m.city end,
      'state', case when m.is_restricted and not v_can_restricted then null else m.state end,
      'is_restricted', m.is_restricted,
      'last_viewed_at', r.last_viewed_at
    ) order by r.last_viewed_at desc)
    from (
      select al.member_id, max(al.occurred_at) as last_viewed_at
      from core.audit_log al
      where al.staff_id = v_staff.id
        and al.action = 'member.view'
        and al.outcome = 'success'
        and al.member_id is not null
        and al.occurred_at > now() - interval '30 days'
      group by al.member_id
      order by max(al.occurred_at) desc
      limit 8
    ) r
    join core.members m on m.id = r.member_id
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------------
-- Member profile
-- ---------------------------------------------------------------------
create or replace function private.get_member(p_member_number text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb;
  v_m core.members;
  v_b core.branches;
begin
  v_err := private.check_permission(v_staff, 'members.view', null, 'Open member profile');
  if v_err is not null then
    return v_err;
  end if;
  v_err := private.member_access_error(v_staff, p_member_number, 'member.view');
  if v_err is not null then
    return v_err;
  end if;

  select * into v_m from core.members where member_number = p_member_number;
  select * into v_b from core.branches where id = v_m.primary_branch_id;

  perform private.audit(v_staff, 'member.view', 'success', v_m.id, null, 'Viewed member ' || v_m.member_number);

  return jsonb_build_object(
    'member', private.member_json(v_m),
    'branch', jsonb_build_object('code', v_b.code, 'name', v_b.name),
    'alerts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', al.id, 'type', al.alert_type, 'severity', al.severity, 'message', al.message,
        'created_at', al.created_at, 'created_by', al.created_by_name
      ) order by case al.severity when 'critical' then 0 when 'warning' then 1 else 2 end, al.created_at desc)
      from core.member_alerts al
      where al.member_id = v_m.id and al.resolved_at is null
    ), '[]'::jsonb),
    'relationships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'member_number', rm.member_number,
        'display_name', private.display_name(rm.first_name, rm.middle_name, rm.last_name, rm.name_suffix),
        'relationship', r.relationship,
        'status', rm.status,
        'is_restricted', rm.is_restricted
      ) order by r.relationship, rm.last_name)
      from core.member_relationships r
      join core.members rm on rm.id = r.related_member_id
      where r.member_id = v_m.id
    ), '[]'::jsonb),
    'summary', (
      select jsonb_build_object(
        'open_accounts', count(*) filter (where a.status <> 'closed'),
        'joint_accounts', count(*) filter (where ids.ownership = 'joint' and a.status <> 'closed'),
        'deposit_total', coalesce(sum(a.current_balance) filter (where p.category <> 'loan' and a.status <> 'closed'), 0),
        'available_total', coalesce(sum(a.available_balance) filter (where p.category <> 'loan' and a.status <> 'closed'), 0),
        'loan_total', coalesce(sum(a.current_balance) filter (where p.category = 'loan' and a.status <> 'closed'), 0),
        'last_activity_on', max(a.last_activity_on)
      )
      from private.member_account_ids(v_m.id) ids
      join core.accounts a on a.id = ids.account_id
      join core.products p on p.code = a.product_code
    ),
    'recent_notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.id, 'category', n.category, 'body', n.body, 'author_name', n.author_name,
        'created_at', n.created_at, 'is_pinned', n.is_pinned
      ) order by n.is_pinned desc, n.created_at desc)
      from (
        select * from core.member_notes
        where member_id = v_m.id
        order by is_pinned desc, created_at desc
        limit 3
      ) n
    ), '[]'::jsonb),
    'notes_count', (select count(*) from core.member_notes where member_id = v_m.id),
    'capabilities', jsonb_build_object(
      'reveal_ssn', private.has_permission(v_staff.role, 'members.view_sensitive'),
      'view_accounts', private.has_permission(v_staff.role, 'accounts.view'),
      'view_transactions', private.has_permission(v_staff.role, 'transactions.view'),
      'open_accounts', private.has_permission(v_staff.role, 'accounts.open'),
      'add_notes', private.has_permission(v_staff.role, 'notes.create'),
      'view_access_log', private.has_permission(v_staff.role, 'audit.view')
    )
  );
end
$$;

create or replace function private.reveal_member_ssn(p_member_number text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb;
  v_m core.members;
begin
  v_err := private.member_access_error(v_staff, p_member_number, 'member.ssn_reveal');
  if v_err is not null then
    return v_err;
  end if;
  select * into v_m from core.members where member_number = p_member_number;

  v_err := private.check_permission(v_staff, 'members.view_sensitive', v_m.id, 'Reveal full SSN for ' || v_m.member_number);
  if v_err is not null then
    return v_err;
  end if;

  perform private.audit(v_staff, 'member.ssn_revealed', 'success', v_m.id, null, 'Revealed full SSN for ' || v_m.member_number);
  return jsonb_build_object(
    'ssn', substr(v_m.ssn, 1, 3) || '-' || substr(v_m.ssn, 4, 2) || '-' || substr(v_m.ssn, 6, 4),
    'revealed_at', now()
  );
end
$$;

-- ---------------------------------------------------------------------
-- Accounts & ledger
-- ---------------------------------------------------------------------
create or replace function private.get_member_accounts(p_member_number text, p_include_closed boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb;
  v_m core.members;
begin
  v_err := private.check_permission(v_staff, 'accounts.view', null, 'View accounts');
  if v_err is not null then
    return v_err;
  end if;
  v_err := private.member_access_error(v_staff, p_member_number, 'member.accounts_view');
  if v_err is not null then
    return v_err;
  end if;
  select * into v_m from core.members where member_number = p_member_number;

  return jsonb_build_object(
    'member_number', v_m.member_number,
    'accounts', coalesce((
      select jsonb_agg(private.account_json(a, p, owner.member_number, ids.ownership)
                       order by p.category, owner.member_number <> v_m.member_number, a.suffix)
      from private.member_account_ids(v_m.id) ids
      join core.accounts a on a.id = ids.account_id
      join core.products p on p.code = a.product_code
      join core.members owner on owner.id = a.member_id
      where coalesce(p_include_closed, false) or a.status <> 'closed'
    ), '[]'::jsonb),
    'closed_count', (
      select count(*)
      from private.member_account_ids(v_m.id) ids
      join core.accounts a on a.id = ids.account_id
      where a.status = 'closed'
    )
  );
end
$$;

create or replace function private.get_account(p_member_number text, p_account_number text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb;
  v_m core.members;
  v_account_id bigint;
  v_result jsonb;
begin
  v_err := private.check_permission(v_staff, 'accounts.view', null, 'View accounts');
  if v_err is not null then
    return v_err;
  end if;
  v_err := private.member_access_error(v_staff, p_member_number, 'account.view');
  if v_err is not null then
    return v_err;
  end if;
  select * into v_m from core.members where member_number = p_member_number;

  v_account_id := private.resolve_account(v_m.id, p_account_number);
  if v_account_id is null then
    return private.fail(404, 'RF404', 'account_not_found', jsonb_build_object('account_number', p_account_number, 'member_number', p_member_number));
  end if;

  select jsonb_build_object(
    'account', private.account_json(a, p, owner.member_number,
      case when a.member_id = v_m.id then 'primary' else 'joint' end),
    'product', jsonb_build_object(
      'code', p.code, 'name', p.name, 'category', p.category, 'description', p.description,
      'min_balance', p.min_balance, 'monthly_fee', p.monthly_fee, 'term_months', p.term_months
    ),
    'owner', jsonb_build_object(
      'member_number', owner.member_number,
      'display_name', private.display_name(owner.first_name, owner.middle_name, owner.last_name, owner.name_suffix)
    ),
    'opening', (
      select jsonb_build_object('confirmation_number', o.confirmation_number, 'opened_at', o.opened_at, 'opened_by', s.full_name)
      from core.account_openings o join core.staff s on s.id = o.opened_by_id
      where o.account_id = a.id
    ),
    'overdraft_source_account_number', (
      select om.member_number || '-' || oa.suffix
      from core.accounts oa join core.members om on om.id = oa.member_id
      where oa.id = a.overdraft_source_account_id
    ),
    'history_starts_on', (
      select min(t.posted_at) from core.transactions t where t.account_id = a.id
    )
  )
  into v_result
  from core.accounts a
  join core.products p on p.code = a.product_code
  join core.members owner on owner.id = a.member_id
  where a.id = v_account_id;

  perform private.audit(v_staff, 'account.view', 'success', v_m.id, v_account_id, 'Viewed account ' || upper(p_account_number));
  return v_result;
end
$$;

create or replace function private.get_account_transactions(
  p_member_number text,
  p_account_number text,
  p_from date default null,
  p_to date default null,
  p_direction text default 'all',
  p_search text default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb;
  v_m core.members;
  v_account_id bigint;
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_direction text := coalesce(nullif(p_direction, ''), 'all');
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_from timestamptz;
  v_to timestamptz;
  v_total integer;
  v_rows jsonb;
  v_forward numeric;
begin
  v_err := private.check_permission(v_staff, 'transactions.view', null, 'View transaction history');
  if v_err is not null then
    return v_err;
  end if;
  if v_direction not in ('all', 'credit', 'debit') then
    return private.invalid(jsonb_build_array(private.field_error('direction', 'Choose all, credits, or debits.')));
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    return private.invalid(jsonb_build_array(private.field_error('to', 'End date must be on or after the start date.')));
  end if;
  v_err := private.member_access_error(v_staff, p_member_number, 'account.history_view');
  if v_err is not null then
    return v_err;
  end if;
  select * into v_m from core.members where member_number = p_member_number;

  v_account_id := private.resolve_account(v_m.id, p_account_number);
  if v_account_id is null then
    return private.fail(404, 'RF404', 'account_not_found', jsonb_build_object('account_number', p_account_number, 'member_number', p_member_number));
  end if;

  v_from := case when p_from is null then null else p_from::timestamp at time zone 'America/New_York' end;
  v_to := case when p_to is null then null else (p_to + 1)::timestamp at time zone 'America/New_York' end;

  with f as (
    select t.*
    from core.transactions t
    where t.account_id = v_account_id
      and (v_from is null or t.posted_at >= v_from)
      and (v_to is null or t.posted_at < v_to)
      and (v_direction = 'all' or (v_direction = 'credit' and t.amount > 0) or (v_direction = 'debit' and t.amount < 0))
      and (v_search is null or t.description ilike '%' || v_search || '%' or t.reference = v_search)
  ),
  page as (
    select * from f order by posted_at desc, id desc limit v_limit offset v_offset
  )
  select (select count(*)::integer from f),
         coalesce((select jsonb_agg(jsonb_build_object(
            'id', page.id,
            'posted_at', page.posted_at,
            'amount', page.amount,
            'balance_after', page.balance_after,
            'type', page.txn_type,
            'channel', page.channel,
            'status', page.status,
            'description', page.description,
            'reference', page.reference
          ) order by page.posted_at desc, page.id desc) from page), '[]'::jsonb)
    into v_total, v_rows;

  -- opening balance of the requested period (the ledger's "balance forward")
  select t.balance_after - t.amount into v_forward
  from core.transactions t
  where t.account_id = v_account_id
    and (v_from is null or t.posted_at >= v_from)
  order by t.posted_at, t.id
  limit 1;

  return jsonb_build_object(
    'account_number', upper(p_account_number),
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'balance_forward', v_forward,
    'rows', v_rows
  );
end
$$;

-- ---------------------------------------------------------------------
-- Notes & access log
-- ---------------------------------------------------------------------
create or replace function private.get_member_notes(p_member_number text, p_limit integer default 20, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb;
  v_m core.members;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  v_err := private.check_permission(v_staff, 'members.view', null, 'View member notes');
  if v_err is not null then
    return v_err;
  end if;
  v_err := private.member_access_error(v_staff, p_member_number, 'member.notes_view');
  if v_err is not null then
    return v_err;
  end if;
  select * into v_m from core.members where member_number = p_member_number;

  return jsonb_build_object(
    'total', (select count(*) from core.member_notes where member_id = v_m.id),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.id, 'category', n.category, 'body', n.body, 'author_name', n.author_name,
        'created_at', n.created_at, 'is_pinned', n.is_pinned
      ) order by n.is_pinned desc, n.created_at desc)
      from (
        select * from core.member_notes where member_id = v_m.id
        order by is_pinned desc, created_at desc
        limit v_limit offset v_offset
      ) n
    ), '[]'::jsonb)
  );
end
$$;

create or replace function private.add_member_note(p_member_number text, p_category text, p_body text, p_is_pinned boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb;
  v_m core.members;
  v_body text := btrim(coalesce(p_body, ''));
  v_fields jsonb := '[]'::jsonb;
  v_note core.member_notes;
begin
  v_err := private.check_permission(v_staff, 'notes.create', null, 'Add member note');
  if v_err is not null then
    return v_err;
  end if;
  v_err := private.member_access_error(v_staff, p_member_number, 'member.note_add');
  if v_err is not null then
    return v_err;
  end if;
  select * into v_m from core.members where member_number = p_member_number;

  if p_category is null or p_category not in ('Service', 'Account maintenance', 'Fraud', 'Collections', 'Complaint', 'Compliance') then
    v_fields := v_fields || private.field_error('category', 'Choose a category.');
  end if;
  if length(v_body) < 5 then
    v_fields := v_fields || private.field_error('body', 'Write at least 5 characters.');
  elsif length(v_body) > 2000 then
    v_fields := v_fields || private.field_error('body', 'Notes can be up to 2,000 characters.');
  end if;
  if jsonb_array_length(v_fields) > 0 then
    return private.invalid(v_fields);
  end if;

  insert into core.member_notes (member_id, author_id, author_name, category, body, is_pinned)
  values (v_m.id, v_staff.id, v_staff.full_name, p_category, v_body, coalesce(p_is_pinned, false))
  returning * into v_note;

  perform private.audit(v_staff, 'member.note_added', 'success', v_m.id, null,
    'Added ' || lower(p_category) || ' note to ' || v_m.member_number, jsonb_build_object('note_id', v_note.id));

  perform set_config('response.status', '201', true);
  return jsonb_build_object(
    'id', v_note.id, 'category', v_note.category, 'body', v_note.body, 'author_name', v_note.author_name,
    'created_at', v_note.created_at, 'is_pinned', v_note.is_pinned
  );
end
$$;

create or replace function private.get_member_access_log(p_member_number text, p_limit integer default 25, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb;
  v_m core.members;
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  v_err := private.check_permission(v_staff, 'audit.view', null, 'View member access log');
  if v_err is not null then
    return v_err;
  end if;
  v_err := private.member_access_error(v_staff, p_member_number, 'member.access_log_view');
  if v_err is not null then
    return v_err;
  end if;
  select * into v_m from core.members where member_number = p_member_number;

  return jsonb_build_object(
    'total', (select count(*) from core.audit_log where member_id = v_m.id),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'reference', 'AUD-' || lpad(l.id::text, 8, '0'),
        'occurred_at', l.occurred_at, 'actor_name', l.actor_name, 'actor_username', l.actor_username,
        'action', l.action, 'outcome', l.outcome, 'summary', l.summary, 'workstation', l.workstation
      ) order by l.occurred_at desc, l.id desc)
      from (
        select * from core.audit_log where member_id = v_m.id
        order by occurred_at desc, id desc
        limit v_limit offset v_offset
      ) l
    ), '[]'::jsonb)
  );
end
$$;

create or replace function private.get_my_activity(p_limit integer default 50, p_offset integer default 0, p_outcome text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if p_outcome is not null and p_outcome not in ('success', 'denied', 'failed') then
    return private.invalid(jsonb_build_array(private.field_error('outcome', 'Unknown outcome.')));
  end if;
  return jsonb_build_object(
    'total', (select count(*) from core.audit_log where staff_id = v_staff.id and (p_outcome is null or outcome = p_outcome)),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'reference', 'AUD-' || lpad(l.id::text, 8, '0'),
        'occurred_at', l.occurred_at, 'action', l.action, 'outcome', l.outcome, 'summary', l.summary,
        'member_number', m.member_number, 'workstation', l.workstation
      ) order by l.occurred_at desc, l.id desc)
      from (
        select * from core.audit_log
        where staff_id = v_staff.id and (p_outcome is null or outcome = p_outcome)
        order by occurred_at desc, id desc
        limit v_limit offset v_offset
      ) l
      left join core.members m on m.id = l.member_id
    ), '[]'::jsonb)
  );
end
$$;

create or replace function private.get_products()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', p.code, 'name', p.name, 'category', p.category, 'description', p.description,
      'min_opening_deposit', p.min_opening_deposit, 'min_balance', p.min_balance, 'rate', p.rate,
      'term_months', p.term_months, 'max_per_member', p.max_per_member, 'min_age', p.min_age, 'max_age', p.max_age,
      'monthly_fee', p.monthly_fee, 'is_openable', p.is_openable, 'updated_at', p.updated_at
    ) order by p.sort_order)
    from core.products p
    where p.is_active
  ), '[]'::jsonb);
end
$$;
