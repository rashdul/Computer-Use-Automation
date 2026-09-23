-- =====================================================================
-- Migration 5 — Administration API (private SECURITY DEFINER)
-- Every function requires admin.console and a password confirmed within
-- the last 15 minutes (private.admin_error). Every change is audited.
-- =====================================================================

create or replace function private.admin_get_overview()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb := private.admin_error(v_staff);
  v_since timestamptz := (private.today()::timestamp at time zone 'America/New_York');
begin
  if v_err is not null then
    return v_err;
  end if;

  return jsonb_build_object(
    'counts', jsonb_build_object(
      'members', (select count(*) from core.members),
      'active_members', (select count(*) from core.members where status = 'active'),
      'restricted_members', (select count(*) from core.members where is_restricted),
      'accounts', (select count(*) from core.accounts),
      'open_accounts', (select count(*) from core.accounts where status <> 'closed'),
      'transactions_estimate', (select greatest(c.reltuples, 0)::bigint from pg_catalog.pg_class c where c.oid = 'core.transactions'::regclass),
      'audit_events_estimate', (select greatest(c.reltuples, 0)::bigint from pg_catalog.pg_class c where c.oid = 'core.audit_log'::regclass),
      'notes', (select count(*) from core.member_notes),
      'staff', (select count(*) from core.staff),
      'active_staff', (select count(*) from core.staff where is_active),
      'active_sessions', (select count(*) from auth.sessions s join core.staff st on st.id = s.user_id)
    ),
    'balances', (
      select jsonb_build_object(
        'deposits', coalesce(sum(a.current_balance) filter (where p.category <> 'loan'), 0),
        'loans', coalesce(sum(a.current_balance) filter (where p.category = 'loan'), 0)
      )
      from core.accounts a join core.products p on p.code = a.product_code
      where a.status <> 'closed'
    ),
    'today', jsonb_build_object(
      'accounts_opened', (select count(*) from core.account_openings where opened_at >= v_since),
      'member_views', (select count(*) from core.audit_log where action = 'member.view' and occurred_at >= v_since),
      'access_denied', (select count(*) from core.audit_log where outcome = 'denied' and occurred_at >= v_since),
      'sign_ins', (select count(*) from core.audit_log where action = 'auth.sign_in' and occurred_at >= v_since)
    ),
    'database_bytes', pg_catalog.pg_database_size(current_database()),
    'environment', private.environment_json(),
    'recent_admin_events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'reference', 'AUD-' || lpad(l.id::text, 8, '0'), 'occurred_at', l.occurred_at,
        'actor_name', l.actor_name, 'action', l.action, 'summary', l.summary
      ) order by l.occurred_at desc)
      from (
        select * from core.audit_log where action like 'admin.%'
        order by occurred_at desc limit 8
      ) l
    ), '[]'::jsonb)
  );
end
$$;

-- ---------------------------------------------------------------------
-- Staff & sessions
-- ---------------------------------------------------------------------
create or replace function private.admin_list_staff()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb := private.admin_error(v_staff);
begin
  if v_err is not null then
    return v_err;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'employee_id', s.employee_id, 'username', s.username, 'full_name', s.full_name,
      'title', s.title, 'role', s.role, 'role_label', private.role_label(s.role),
      'branch_code', b.code, 'branch_name', b.name, 'workstation', s.workstation,
      'is_active', s.is_active, 'last_sign_in_at', s.last_sign_in_at,
      'active_sessions', (select count(*) from auth.sessions x where x.user_id = s.id),
      'is_you', s.id = v_staff.id
    ) order by s.is_active desc, s.full_name)
    from core.staff s join core.branches b on b.id = s.branch_id
  ), '[]'::jsonb);
end
$$;

create or replace function private.admin_update_staff(p_staff_id uuid, p_role text default null, p_is_active boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb := private.admin_error(v_staff);
  v_target core.staff;
  v_new_role core.staff_role;
  v_ended integer := 0;
  v_changes jsonb := '{}'::jsonb;
begin
  if v_err is not null then
    return v_err;
  end if;

  select * into v_target from core.staff where id = p_staff_id;
  if not found then
    return private.fail(404, 'RF404', 'not_found', jsonb_build_object('staff_id', p_staff_id));
  end if;
  if v_target.id = v_staff.id and (p_is_active is false or (p_role is not null and p_role <> v_staff.role::text)) then
    return private.fail(409, 'RF409', 'self_lockout', jsonb_build_object(
      'message', 'You can''t change your own role or deactivate yourself. Ask another administrator.'));
  end if;
  if p_role is not null then
    if p_role not in ('teller', 'member_service_rep', 'branch_manager', 'compliance_officer', 'system_admin') then
      return private.invalid(jsonb_build_array(private.field_error('role', 'Unknown role.')));
    end if;
    v_new_role := p_role::core.staff_role;
  end if;

  if v_new_role is not null and v_new_role <> v_target.role then
    v_changes := v_changes || jsonb_build_object('role', jsonb_build_object('from', v_target.role, 'to', v_new_role));
  end if;
  if p_is_active is not null and p_is_active <> v_target.is_active then
    v_changes := v_changes || jsonb_build_object('is_active', jsonb_build_object('from', v_target.is_active, 'to', p_is_active));
  end if;
  if v_changes = '{}'::jsonb then
    return jsonb_build_object('changed', false);
  end if;

  update core.staff
     set role = coalesce(v_new_role, role),
         is_active = coalesce(p_is_active, is_active)
   where id = v_target.id;

  -- a deactivated user loses every live session immediately
  if p_is_active is false then
    delete from auth.sessions where user_id = v_target.id;
    get diagnostics v_ended = row_count;
  end if;

  perform private.audit(v_staff, 'admin.staff_updated', 'success', null, null,
    'Updated ' || v_target.full_name || ' (' || v_target.username || ')',
    v_changes || jsonb_build_object('sessions_ended', v_ended, 'staff_username', v_target.username));

  return jsonb_build_object('changed', true, 'changes', v_changes, 'sessions_ended', v_ended);
end
$$;

create or replace function private.admin_list_sessions()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb := private.admin_error(v_staff);
  v_current uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
begin
  if v_err is not null then
    return v_err;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'session_id', se.id,
      'staff_id', st.id, 'full_name', st.full_name, 'username', st.username,
      'role_label', private.role_label(st.role), 'workstation', st.workstation,
      'started_at', se.created_at,
      'last_active_at', coalesce(se.refreshed_at at time zone 'UTC', se.updated_at),
      'user_agent', left(se.user_agent, 160),
      'is_current', se.id = v_current
    ) order by se.created_at desc)
    from auth.sessions se
    join core.staff st on st.id = se.user_id
  ), '[]'::jsonb);
end
$$;

-- p_staff_id null → every session except the caller's current one.
create or replace function private.admin_end_sessions(p_staff_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb := private.admin_error(v_staff);
  v_current uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_ended integer;
  v_target core.staff;
begin
  if v_err is not null then
    return v_err;
  end if;

  if p_staff_id is not null then
    select * into v_target from core.staff where id = p_staff_id;
    if not found then
      return private.fail(404, 'RF404', 'not_found', jsonb_build_object('staff_id', p_staff_id));
    end if;
  end if;

  delete from auth.sessions s
   where (p_staff_id is null or s.user_id = p_staff_id)
     and s.id is distinct from v_current
     and exists (select 1 from core.staff st where st.id = s.user_id);
  get diagnostics v_ended = row_count;

  perform private.audit(v_staff, 'admin.sessions_ended', 'success', null, null,
    case when p_staff_id is null then 'Ended all other staff sessions (' || v_ended || ')'
         else 'Ended ' || v_ended || ' session' || case when v_ended = 1 then '' else 's' end || ' for ' || v_target.full_name end,
    jsonb_build_object('sessions_ended', v_ended, 'staff_username', v_target.username));

  return jsonb_build_object('sessions_ended', v_ended);
end
$$;

-- ---------------------------------------------------------------------
-- Roles & permissions
-- ---------------------------------------------------------------------
create or replace function private.admin_get_permissions()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb := private.admin_error(v_staff);
begin
  if v_err is not null then
    return v_err;
  end if;
  return jsonb_build_object(
    'roles', (
      select jsonb_agg(jsonb_build_object(
        'role', r.role, 'label', private.role_label(r.role),
        'staff_count', (select count(*) from core.staff s where s.role = r.role and s.is_active)
      ) order by r.ord)
      from unnest(enum_range(null::core.staff_role)) with ordinality as r(role, ord)
    ),
    'permissions', (
      select jsonb_agg(jsonb_build_object(
        'code', p.code, 'label', p.label, 'description', p.description, 'category', p.category,
        'granted_to', coalesce((select jsonb_agg(rp.role order by rp.role) from core.role_permissions rp where rp.permission_code = p.code), '[]'::jsonb)
      ) order by p.sort_order)
      from core.permissions p
    )
  );
end
$$;

create or replace function private.admin_set_role_permission(p_role text, p_permission text, p_granted boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb := private.admin_error(v_staff);
  v_role core.staff_role;
  v_label text;
  v_rows integer;
begin
  if v_err is not null then
    return v_err;
  end if;
  if p_role is null or p_role not in ('teller', 'member_service_rep', 'branch_manager', 'compliance_officer', 'system_admin') then
    return private.invalid(jsonb_build_array(private.field_error('role', 'Unknown role.')));
  end if;
  v_role := p_role::core.staff_role;
  select label into v_label from core.permissions where code = p_permission;
  if v_label is null then
    return private.invalid(jsonb_build_array(private.field_error('permission', 'Unknown permission.')));
  end if;
  if p_granted is null then
    return private.invalid(jsonb_build_array(private.field_error('granted', 'Choose grant or revoke.')));
  end if;
  if v_role = 'system_admin' and p_permission = 'admin.console' and not p_granted then
    return private.fail(409, 'RF409', 'self_lockout', jsonb_build_object(
      'message', 'System Administrators must keep access to Administration.'));
  end if;

  if p_granted then
    insert into core.role_permissions (role, permission_code) values (v_role, p_permission) on conflict do nothing;
  else
    delete from core.role_permissions where role = v_role and permission_code = p_permission;
  end if;
  get diagnostics v_rows = row_count;

  if v_rows > 0 then
    perform private.audit(v_staff, 'admin.permission_changed', 'success', null, null,
      case when p_granted then 'Granted "' || v_label || '" to ' else 'Revoked "' || v_label || '" from ' end || private.role_label(v_role),
      jsonb_build_object('role', v_role, 'permission', p_permission, 'granted', p_granted));
  end if;
  return jsonb_build_object('changed', v_rows > 0, 'role', v_role, 'permission', p_permission, 'granted', p_granted);
end
$$;

-- ---------------------------------------------------------------------
-- Environment controls
-- ---------------------------------------------------------------------
create or replace function private.admin_get_environment()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb := private.admin_error(v_staff);
begin
  if v_err is not null then
    return v_err;
  end if;
  return private.environment_json();
end
$$;

create or replace function private.admin_update_environment(p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb := private.admin_error(v_staff);
  v_before jsonb;
  v_after jsonb;
  v_unknown text[];
  v_diff jsonb;
begin
  if v_err is not null then
    return v_err;
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    return private.invalid(jsonb_build_array(private.field_error('settings', 'Send the settings to change.')));
  end if;
  v_unknown := array(
    select k from jsonb_object_keys(p_patch) k
    where k not in ('latency_mode', 'latency_fixed_ms', 'latency_min_ms', 'latency_max_ms', 'latency_scope',
                    'slow_notice_after_ms', 'request_timeout_ms', 'failure_rate_pct', 'failure_scope',
                    'interrupts_enabled', 'interrupt_trigger', 'interrupt_probability_pct', 'interrupt_kinds',
                    'interrupt_once_per_session', 'interrupt_delay_ms', 'idle_timeout_minutes',
                    'idle_warning_seconds', 'maintenance_banner')
  );
  if array_length(v_unknown, 1) > 0 then
    return private.invalid(jsonb_build_array(private.field_error('settings', 'Unknown setting: ' || array_to_string(v_unknown, ', ') || '.')));
  end if;

  v_before := private.environment_json();

  begin
    update core.environment_settings e set
      latency_mode = coalesce(p_patch ->> 'latency_mode', e.latency_mode),
      latency_fixed_ms = coalesce((p_patch ->> 'latency_fixed_ms')::integer, e.latency_fixed_ms),
      latency_min_ms = coalesce((p_patch ->> 'latency_min_ms')::integer, e.latency_min_ms),
      latency_max_ms = coalesce((p_patch ->> 'latency_max_ms')::integer, e.latency_max_ms),
      latency_scope = coalesce(p_patch ->> 'latency_scope', e.latency_scope),
      slow_notice_after_ms = coalesce((p_patch ->> 'slow_notice_after_ms')::integer, e.slow_notice_after_ms),
      request_timeout_ms = coalesce((p_patch ->> 'request_timeout_ms')::integer, e.request_timeout_ms),
      failure_rate_pct = coalesce((p_patch ->> 'failure_rate_pct')::smallint, e.failure_rate_pct),
      failure_scope = coalesce(p_patch ->> 'failure_scope', e.failure_scope),
      interrupts_enabled = coalesce((p_patch ->> 'interrupts_enabled')::boolean, e.interrupts_enabled),
      interrupt_trigger = coalesce(p_patch ->> 'interrupt_trigger', e.interrupt_trigger),
      interrupt_probability_pct = coalesce((p_patch ->> 'interrupt_probability_pct')::smallint, e.interrupt_probability_pct),
      interrupt_kinds = case when p_patch ? 'interrupt_kinds'
                             then array(select jsonb_array_elements_text(p_patch -> 'interrupt_kinds'))
                             else e.interrupt_kinds end,
      interrupt_once_per_session = coalesce((p_patch ->> 'interrupt_once_per_session')::boolean, e.interrupt_once_per_session),
      interrupt_delay_ms = coalesce((p_patch ->> 'interrupt_delay_ms')::integer, e.interrupt_delay_ms),
      idle_timeout_minutes = coalesce((p_patch ->> 'idle_timeout_minutes')::smallint, e.idle_timeout_minutes),
      idle_warning_seconds = coalesce((p_patch ->> 'idle_warning_seconds')::smallint, e.idle_warning_seconds),
      maintenance_banner = case when p_patch ? 'maintenance_banner'
                                then nullif(btrim(coalesce(p_patch ->> 'maintenance_banner', '')), '')
                                else e.maintenance_banner end,
      updated_at = now(),
      updated_by_name = v_staff.full_name
    where e.id = 1;
  exception
    when check_violation or invalid_text_representation or numeric_value_out_of_range or datatype_mismatch then
      return private.invalid(jsonb_build_array(private.field_error('settings',
        'One or more values are out of range. ' || coalesce(sqlerrm, ''))));
  end;

  v_after := private.environment_json();
  select jsonb_object_agg(a.key, jsonb_build_object('from', b.value, 'to', a.value))
    into v_diff
  from jsonb_each(v_after) a
  join jsonb_each(v_before) b using (key)
  where a.value is distinct from b.value
    and a.key not in ('updated_at', 'updated_by_name');

  if v_diff is not null then
    perform private.audit(v_staff, 'admin.environment_updated', 'success', null, null,
      'Changed environment controls: ' || (select string_agg(k, ', ' order by k) from jsonb_object_keys(v_diff) k),
      v_diff);
  end if;

  return v_after;
end
$$;

create or replace function private.admin_reset_environment()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb := private.admin_error(v_staff);
begin
  if v_err is not null then
    return v_err;
  end if;
  delete from core.environment_settings where id = 1;
  insert into core.environment_settings (id, updated_by_name) values (1, v_staff.full_name);
  perform private.audit(v_staff, 'admin.environment_reset', 'success', null, null, 'Reset environment controls to defaults');
  return private.environment_json();
end
$$;

-- ---------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------
create or replace function private.admin_list_products()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb := private.admin_error(v_staff);
begin
  if v_err is not null then
    return v_err;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', p.code, 'name', p.name, 'category', p.category, 'rate', p.rate,
      'min_opening_deposit', p.min_opening_deposit, 'min_balance', p.min_balance, 'term_months', p.term_months,
      'max_per_member', p.max_per_member, 'monthly_fee', p.monthly_fee, 'is_openable', p.is_openable,
      'is_active', p.is_active, 'updated_at', p.updated_at,
      'open_accounts', (select count(*) from core.accounts a where a.product_code = p.code and a.status <> 'closed')
    ) order by p.sort_order)
    from core.products p
  ), '[]'::jsonb);
end
$$;

create or replace function private.admin_update_product(p_code text, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb := private.admin_error(v_staff);
  v_p core.products;
  v_rate numeric;
  v_min numeric;
  v_fields jsonb := '[]'::jsonb;
  v_diff jsonb := '{}'::jsonb;
begin
  if v_err is not null then
    return v_err;
  end if;
  select * into v_p from core.products where code = p_code;
  if not found then
    return private.fail(404, 'RF404', 'not_found', jsonb_build_object('product_code', p_code));
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    return private.invalid(jsonb_build_array(private.field_error('product', 'Send the fields to change.')));
  end if;

  if p_patch ? 'rate' then
    v_rate := private.try_numeric(p_patch ->> 'rate');
    if v_rate is null or v_rate < 0 or v_rate > 25 or v_rate <> round(v_rate, 3) then
      v_fields := v_fields || private.field_error('rate', 'Enter a rate between 0.000 and 25.000.');
    end if;
  end if;
  if p_patch ? 'min_opening_deposit' then
    v_min := private.try_numeric(p_patch ->> 'min_opening_deposit');
    if v_min is null or v_min < 0 or v_min > 100000 or v_min <> round(v_min, 2) then
      v_fields := v_fields || private.field_error('min_opening_deposit', 'Enter an amount between $0.00 and $100,000.00.');
    end if;
  end if;
  if p_patch ? 'is_active' and jsonb_typeof(p_patch -> 'is_active') <> 'boolean' then
    v_fields := v_fields || private.field_error('is_active', 'Choose offered or not offered.');
  end if;
  if jsonb_array_length(v_fields) > 0 then
    return private.invalid(v_fields);
  end if;

  if v_rate is not null and v_rate <> v_p.rate then
    v_diff := v_diff || jsonb_build_object('rate', jsonb_build_object('from', v_p.rate, 'to', v_rate));
  end if;
  if v_min is not null and v_min <> v_p.min_opening_deposit then
    v_diff := v_diff || jsonb_build_object('min_opening_deposit', jsonb_build_object('from', v_p.min_opening_deposit, 'to', v_min));
  end if;
  if p_patch ? 'is_active' and (p_patch ->> 'is_active')::boolean <> v_p.is_active then
    v_diff := v_diff || jsonb_build_object('is_active', jsonb_build_object('from', v_p.is_active, 'to', (p_patch ->> 'is_active')::boolean));
  end if;
  if v_diff = '{}'::jsonb then
    return jsonb_build_object('changed', false);
  end if;

  update core.products set
    rate = coalesce(v_rate, rate),
    min_opening_deposit = coalesce(v_min, min_opening_deposit),
    is_active = coalesce((p_patch ->> 'is_active')::boolean, is_active),
    updated_at = now()
  where code = p_code;

  perform private.audit(v_staff, 'admin.product_updated', 'success', null, null, 'Updated product ' || v_p.name, v_diff);
  return jsonb_build_object('changed', true, 'changes', v_diff);
end
$$;

-- ---------------------------------------------------------------------
-- Audit search & test data catalogue
-- ---------------------------------------------------------------------
create or replace function private.admin_search_audit(
  p_actor text default null,
  p_action text default null,
  p_outcome text default null,
  p_member_number text default null,
  p_from date default null,
  p_to date default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb := private.admin_error(v_staff);
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_actor text := nullif(lower(btrim(coalesce(p_actor, ''))), '');
  v_action text := nullif(btrim(coalesce(p_action, '')), '');
  v_member_id bigint;
  v_from timestamptz := case when p_from is null then null else p_from::timestamp at time zone 'America/New_York' end;
  v_to timestamptz := case when p_to is null then null else (p_to + 1)::timestamp at time zone 'America/New_York' end;
  v_total integer;
  v_rows jsonb;
begin
  if v_err is not null then
    return v_err;
  end if;
  if p_outcome is not null and p_outcome not in ('success', 'denied', 'failed') then
    return private.invalid(jsonb_build_array(private.field_error('outcome', 'Unknown outcome.')));
  end if;
  if nullif(btrim(coalesce(p_member_number, '')), '') is not null then
    select id into v_member_id from core.members where member_number = btrim(p_member_number);
    if v_member_id is null then
      return jsonb_build_object('total', 0, 'limit', v_limit, 'offset', v_offset, 'rows', '[]'::jsonb);
    end if;
  end if;

  with f as (
    select l.*
    from core.audit_log l
    where (v_actor is null or l.actor_username = v_actor or lower(l.actor_name) like '%' || v_actor || '%')
      and (v_action is null or l.action = v_action or l.action like v_action || '.%')
      and (p_outcome is null or l.outcome = p_outcome)
      and (v_member_id is null or l.member_id = v_member_id)
      and (v_from is null or l.occurred_at >= v_from)
      and (v_to is null or l.occurred_at < v_to)
  ),
  page as (
    select * from f order by occurred_at desc, id desc limit v_limit offset v_offset
  )
  select (select count(*)::integer from f),
         coalesce((select jsonb_agg(jsonb_build_object(
            'reference', 'AUD-' || lpad(page.id::text, 8, '0'),
            'occurred_at', page.occurred_at,
            'actor_name', page.actor_name,
            'actor_username', page.actor_username,
            'action', page.action,
            'outcome', page.outcome,
            'summary', page.summary,
            'member_number', m.member_number,
            'workstation', page.workstation,
            'details', page.details
          ) order by page.occurred_at desc, page.id desc)
          from page left join core.members m on m.id = page.member_id), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'rows', v_rows);
end
$$;

create or replace function private.admin_get_test_scenarios()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb := private.admin_error(v_staff);
begin
  if v_err is not null then
    return v_err;
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(t) order by t.sort_order)
    from core.test_scenarios t
  ), '[]'::jsonb);
end
$$;
