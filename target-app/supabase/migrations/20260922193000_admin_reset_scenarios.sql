-- =====================================================================
-- Migration 7 — reset the test-data catalogue
--
-- Automated replays open real sub-accounts on the fixture members, which
-- changes later runs (e.g. the duplicate-product confirmation appears).
-- This reverses every sub-account opened through the console for members
-- listed in core.test_scenarios: funding is credited back to its source,
-- then the new account, its ledger, parties, and opening record are removed.
-- The audit trail is append-only and is kept.
-- =====================================================================

create or replace function private.admin_reset_scenarios()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb := private.admin_error(v_staff);
  v_opening record;
  v_count integer := 0;
  v_refunded numeric := 0;
begin
  if v_err is not null then
    return v_err;
  end if;

  for v_opening in
    select o.*, m.member_number, a.suffix
    from core.account_openings o
    join core.members m on m.id = o.member_id
    join core.accounts a on a.id = o.account_id
    where m.member_number in (select t.member_number from core.test_scenarios t where t.member_number is not null)
    order by o.opened_at desc
  loop
    if v_opening.funding_method = 'transfer' and v_opening.funding_account_id is not null then
      update core.accounts
         set current_balance = current_balance + v_opening.initial_deposit,
             available_balance = available_balance + v_opening.initial_deposit
       where id = v_opening.funding_account_id;
      delete from core.transactions t
       where t.account_id = v_opening.funding_account_id
         and t.amount = -v_opening.initial_deposit
         and t.description like 'Transfer to ' || v_opening.member_number || '-' || v_opening.suffix || '%';
      v_refunded := v_refunded + v_opening.initial_deposit;
    end if;

    delete from core.account_openings where id = v_opening.id;
    delete from core.transactions where account_id = v_opening.account_id;
    delete from core.account_parties where account_id = v_opening.account_id;
    update core.accounts set overdraft_source_account_id = null where overdraft_source_account_id = v_opening.account_id;
    delete from core.accounts where id = v_opening.account_id;
    v_count := v_count + 1;
  end loop;

  perform private.audit(v_staff, 'admin.scenarios_reset', 'success', null, null,
    'Reset test data: reversed ' || v_count || ' sub-account opening' || case when v_count = 1 then '' else 's' end,
    jsonb_build_object('openings_reversed', v_count, 'funds_returned', v_refunded));

  return jsonb_build_object('openings_reversed', v_count, 'funds_returned', v_refunded);
end
$$;

create or replace function public.admin_reset_scenarios()
returns jsonb language sql security invoker set search_path = '' as $$
  select private.admin_reset_scenarios()
$$;

revoke execute on function private.admin_reset_scenarios() from public, anon, authenticated;
revoke execute on function public.admin_reset_scenarios() from public, anon, authenticated;
grant execute on function private.admin_reset_scenarios() to authenticated;
grant execute on function public.admin_reset_scenarios() to authenticated;
