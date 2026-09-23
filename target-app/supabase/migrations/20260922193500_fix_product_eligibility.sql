-- =====================================================================
-- Migration 8 — generate_series(smallint, smallint) is ambiguous
-- (smallint casts implicitly to int, bigint and numeric). Cast explicitly.
-- =====================================================================

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
  from (
    select p.suffix_prefix || lpad(n::text, 2, '0') as s
    from generate_series(p.suffix_min::integer, p.suffix_max::integer) n
  ) c
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
