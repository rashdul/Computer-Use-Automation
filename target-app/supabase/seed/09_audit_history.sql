-- Sixty days of staff activity. Consistent with permissions: opening a
-- restricted record without clearance is logged as a denial, not a view.
select setseed(0.83);

drop table if exists seed.sd;
create unlogged table seed.sd as
with st as (
  select s.*, case s.role when 'teller' then 1.0 when 'member_service_rep' then 0.9 when 'branch_manager' then 0.5
                          when 'compliance_officer' then 0.6 else 0.15 end as intensity
  from core.staff s where s.is_active
),
days as (
  select d::date as day
  from generate_series(date '2026-07-24', date '2026-09-21', interval '1 day') d
  where extract(isodow from d) <= 6
)
select st.id, st.username, st.full_name, st.workstation, st.role, st.intensity, days.day,
       (extract(isodow from days.day) = 6) as saturday
from st cross join days
where random() < case when extract(isodow from days.day) = 6 then 0.3 else 0.88 end;

insert into core.audit_log (occurred_at, staff_id, actor_username, actor_name, action, outcome, summary, details, workstation)
select seed.at(sd.day, 8.6 + random() * 0.8), sd.id, sd.username, sd.full_name, 'auth.sign_in', 'success', 'Signed in', '{}'::jsonb, sd.workstation
from seed.sd sd
union all
select seed.at(sd.day, case when sd.saturday then 12.6 else 17.1 end + random() * 0.7), sd.id, sd.username, sd.full_name,
       'auth.sign_out', 'success', 'Signed out', '{}'::jsonb, sd.workstation
from seed.sd sd;

drop table if exists seed.ev;
create unlogged table seed.ev as
select sd.id as staff_id, sd.username, sd.full_name, sd.workstation, sd.role,
       seed.at(sd.day, case when sd.saturday then 9 + random() * 3.3 else 9.1 + random() * 7.7 end) as at,
       1 + floor(random() * 50000)::bigint as member_id,
       random() as r, random() as r2
from seed.sd sd
cross join lateral generate_series(1, greatest(1, floor(sd.intensity * (8 + random() * 22))::int) + 0 * length(sd.username)) k;

insert into core.audit_log (occurred_at, staff_id, actor_username, actor_name, action, outcome, member_id, account_id, summary, details, workstation)
-- the search that found the member
select e.at - interval '45 seconds', e.staff_id, e.username, e.full_name, 'member.search', 'success', null::bigint, null::bigint,
       'Searched members by ' || q.kind || ' (' || q.cnt || ' result' || case when q.cnt = 1 then '' else 's' end || ')',
       jsonb_build_object('query_type', replace(q.kind, ' ', '_'), 'result_count', q.cnt), e.workstation
from seed.ev e
cross join lateral (
  select case when e.r2 < 0.6 then 'name' when e.r2 < 0.85 then 'member number' when e.r2 < 0.93 then 'ssn last4' else 'phone' end as kind,
         case when e.r2 < 0.6 then 1 + floor(e.r2 * 60)::int when e.r2 < 0.85 then 1 when e.r2 < 0.93 then 2 + floor(e.r2 * 7)::int % 6 else 1 end as cnt
) q
where e.r < 0.75
union all
-- the view itself (or a denial for restricted records)
select e.at, e.staff_id, e.username, e.full_name,
       case when m.is_restricted and e.role not in ('branch_manager', 'compliance_officer') then 'access.denied' else 'member.view' end,
       case when m.is_restricted and e.role not in ('branch_manager', 'compliance_officer') then 'denied' else 'success' end,
       m.id, null::bigint,
       case when m.is_restricted and e.role not in ('branch_manager', 'compliance_officer')
            then 'Blocked: restricted record ' || m.member_number else 'Viewed member ' || m.member_number end,
       case when m.is_restricted and e.role not in ('branch_manager', 'compliance_officer')
            then jsonb_build_object('permission', 'members.view_restricted', 'restriction', m.restriction_reason)
            else '{}'::jsonb end,
       e.workstation
from seed.ev e join core.members m on m.id = e.member_id
union all
-- account drill-down
select e.at + interval '100 seconds', e.staff_id, e.username, e.full_name, 'account.view', 'success', m.id, a.id,
       'Viewed account ' || m.member_number || '-' || a.suffix, '{}'::jsonb, e.workstation
from seed.ev e
join core.members m on m.id = e.member_id and not (m.is_restricted and e.role not in ('branch_manager', 'compliance_officer'))
cross join lateral (
  select ac.id, ac.suffix from core.accounts ac where ac.member_id = e.member_id
  order by ac.suffix offset floor(e.r2 * 2)::int limit 1
) a
where e.r < 0.5
union all
-- SSN reveals by roles that may reveal
select e.at + interval '70 seconds', e.staff_id, e.username, e.full_name, 'member.ssn_revealed', 'success', m.id, null::bigint,
       'Revealed full SSN for ' || m.member_number, '{}'::jsonb, e.workstation
from seed.ev e join core.members m on m.id = e.member_id
where e.role in ('member_service_rep', 'branch_manager', 'compliance_officer') and e.r > 0.94
  and not (m.is_restricted and e.role = 'member_service_rep')
union all
-- tellers occasionally try to open accounts
select e.at + interval '3 minutes', e.staff_id, e.username, e.full_name, 'access.denied', 'denied', m.id, null::bigint,
       'Blocked: Open a sub-account', jsonb_build_object('permission', 'accounts.open', 'role', 'teller'), e.workstation
from seed.ev e join core.members m on m.id = e.member_id
where e.role = 'teller' and e.r > 0.985 and not m.is_restricted;

-- account openings by current staff in the window
insert into core.audit_log (occurred_at, staff_id, actor_username, actor_name, action, outcome, member_id, account_id, summary, details, workstation)
select seed.at(a.opened_on, 10 + random() * 6), s.id, s.username, s.full_name, 'account.opened', 'success', m.id, a.id,
       'Opened ' || m.member_number || '-' || a.suffix || ' · ' || p.name,
       jsonb_build_object('product_code', p.code), s.workstation
from core.accounts a
join core.staff s on s.id = a.opened_by_id
join core.members m on m.id = a.member_id
join core.products p on p.code = a.product_code
where a.opened_on >= date '2026-07-24' and p.category <> 'loan';

-- notes written in the window
insert into core.audit_log (occurred_at, staff_id, actor_username, actor_name, action, outcome, member_id, summary, details, workstation)
select n.created_at, s.id, s.username, s.full_name, 'member.note_added', 'success', n.member_id,
       'Added ' || lower(n.category) || ' note to ' || m.member_number, jsonb_build_object('note_id', n.id), s.workstation
from core.member_notes n
join core.staff s on s.id = n.author_id
join core.members m on m.id = n.member_id
where n.created_at >= timestamptz '2026-07-24';

select count(*) as audit_rows,
       count(*) filter (where outcome = 'denied') as denied,
       count(distinct staff_id) as staff,
       min(occurred_at) as first_at, max(occurred_at) as last_at,
       pg_size_pretty(pg_total_relation_size('core.audit_log')) as size
from core.audit_log;
