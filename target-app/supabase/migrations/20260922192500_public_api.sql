-- =====================================================================
-- Migration 6 — public API surface
--
-- One SECURITY INVOKER wrapper per operation. Wrappers hold no logic;
-- they exist so that no SECURITY DEFINER function lives in an exposed
-- schema. Only `authenticated` may execute them.
-- =====================================================================

-- Session ---------------------------------------------------------------
create or replace function public.get_session_context()
returns jsonb language sql security invoker set search_path = '' as $$
  select private.get_session_context()
$$;

create or replace function public.session_heartbeat()
returns jsonb language sql security invoker set search_path = '' as $$
  select private.session_heartbeat()
$$;

create or replace function public.record_auth_event(p_event text, p_details jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.record_auth_event(p_event, p_details)
$$;

-- Members ------------------------------------------------------------------
create or replace function public.search_members(
  p_query text, p_status text default null, p_branch text default null,
  p_sort text default 'relevance', p_limit integer default 25, p_offset integer default 0)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.search_members(p_query, p_status, p_branch, p_sort, p_limit, p_offset)
$$;

create or replace function public.get_recent_members()
returns jsonb language sql security invoker set search_path = '' as $$
  select private.get_recent_members()
$$;

create or replace function public.get_member(p_member_number text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.get_member(p_member_number)
$$;

create or replace function public.reveal_member_ssn(p_member_number text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.reveal_member_ssn(p_member_number)
$$;

create or replace function public.get_member_notes(p_member_number text, p_limit integer default 20, p_offset integer default 0)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.get_member_notes(p_member_number, p_limit, p_offset)
$$;

create or replace function public.add_member_note(p_member_number text, p_category text, p_body text, p_is_pinned boolean default false)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.add_member_note(p_member_number, p_category, p_body, p_is_pinned)
$$;

create or replace function public.get_member_access_log(p_member_number text, p_limit integer default 25, p_offset integer default 0)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.get_member_access_log(p_member_number, p_limit, p_offset)
$$;

create or replace function public.get_my_activity(p_limit integer default 50, p_offset integer default 0, p_outcome text default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.get_my_activity(p_limit, p_offset, p_outcome)
$$;

-- Accounts --------------------------------------------------------------------
create or replace function public.get_member_accounts(p_member_number text, p_include_closed boolean default false)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.get_member_accounts(p_member_number, p_include_closed)
$$;

create or replace function public.get_account(p_member_number text, p_account_number text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.get_account(p_member_number, p_account_number)
$$;

create or replace function public.get_account_transactions(
  p_member_number text, p_account_number text, p_from date default null, p_to date default null,
  p_direction text default 'all', p_search text default null, p_limit integer default 25, p_offset integer default 0)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.get_account_transactions(p_member_number, p_account_number, p_from, p_to, p_direction, p_search, p_limit, p_offset)
$$;

create or replace function public.get_products()
returns jsonb language sql security invoker set search_path = '' as $$
  select private.get_products()
$$;

-- Account opening ------------------------------------------------------------------
create or replace function public.get_open_account_context(p_member_number text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.get_open_account_context(p_member_number)
$$;

create or replace function public.lookup_member_brief(p_member_number text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.lookup_member_brief(p_member_number)
$$;

create or replace function public.open_sub_account(p_request jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.open_sub_account(p_request)
$$;

create or replace function public.get_account_opening(p_confirmation_number text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.get_account_opening(p_confirmation_number)
$$;

-- Administration ----------------------------------------------------------------------
create or replace function public.admin_get_overview()
returns jsonb language sql security invoker set search_path = '' as $$
  select private.admin_get_overview()
$$;

create or replace function public.admin_list_staff()
returns jsonb language sql security invoker set search_path = '' as $$
  select private.admin_list_staff()
$$;

create or replace function public.admin_update_staff(p_staff_id uuid, p_role text default null, p_is_active boolean default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.admin_update_staff(p_staff_id, p_role, p_is_active)
$$;

create or replace function public.admin_list_sessions()
returns jsonb language sql security invoker set search_path = '' as $$
  select private.admin_list_sessions()
$$;

create or replace function public.admin_end_sessions(p_staff_id uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.admin_end_sessions(p_staff_id)
$$;

create or replace function public.admin_get_permissions()
returns jsonb language sql security invoker set search_path = '' as $$
  select private.admin_get_permissions()
$$;

create or replace function public.admin_set_role_permission(p_role text, p_permission text, p_granted boolean)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.admin_set_role_permission(p_role, p_permission, p_granted)
$$;

create or replace function public.admin_get_environment()
returns jsonb language sql security invoker set search_path = '' as $$
  select private.admin_get_environment()
$$;

create or replace function public.admin_update_environment(p_patch jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.admin_update_environment(p_patch)
$$;

create or replace function public.admin_reset_environment()
returns jsonb language sql security invoker set search_path = '' as $$
  select private.admin_reset_environment()
$$;

create or replace function public.admin_list_products()
returns jsonb language sql security invoker set search_path = '' as $$
  select private.admin_list_products()
$$;

create or replace function public.admin_update_product(p_code text, p_patch jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.admin_update_product(p_code, p_patch)
$$;

create or replace function public.admin_search_audit(
  p_actor text default null, p_action text default null, p_outcome text default null,
  p_member_number text default null, p_from date default null, p_to date default null,
  p_limit integer default 50, p_offset integer default 0)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.admin_search_audit(p_actor, p_action, p_outcome, p_member_number, p_from, p_to, p_limit, p_offset)
$$;

create or replace function public.admin_get_test_scenarios()
returns jsonb language sql security invoker set search_path = '' as $$
  select private.admin_get_test_scenarios()
$$;

-- Grants -----------------------------------------------------------------------------
-- Nothing in private is callable by default; the API roles get EXECUTE on
-- exactly the entry points the public wrappers delegate to.
revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute format('grant execute on function %s to authenticated', f.sig);
    execute format('grant execute on function private.%I to authenticated',
      f.proname) ;
  end loop;
end $$;
