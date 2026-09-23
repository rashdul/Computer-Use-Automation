-- Sub-accounts. Every member holds S00 (the membership share); other
-- products are drawn by age and status. Balances are log-normal; loans are
-- amortised from their open date. Transactions come later (07).
select setseed(0.47);

drop table if exists seed.plan;
create unlogged table seed.plan as
with mm as materialized (
  select m.id as member_id,
    private.age_on(m.date_of_birth, date '2026-09-22') as age,
    random() as r1, random() as r2, random() as r3, random() as r4, random() as r5, random() as r6, random() as r7,
    random() as r8, random() as r9, random() as r10, random() as r11, random() as r12, random() as r13
  from core.members m
)
select mm.member_id, x.product_code
from mm
cross join lateral (
  select 'SHR-MEM'::text as product_code
  union all select 'SHR-REG' where mm.age >= 18 and mm.r1 < 0.45
  union all select 'SHR-REG' where mm.age >= 18 and mm.r1 < 0.06
  union all select 'SHR-YTH' where mm.age < 18 and mm.r1 < 0.8
  union all select 'CLB-HOL' where mm.r7 < case when mm.age < 18 then 0.10 else 0.06 end
  union all select 'CLB-VAC' where mm.age >= 18 and mm.r8 < 0.03
  union all select 'DFT-BAS' where mm.age >= 16 and mm.r2 < 0.35
  union all select 'DFT-PRM' where mm.age >= 18 and mm.r2 >= 0.35 and mm.r2 < 0.55
  union all select 'DFT-BAS' where mm.age >= 18 and mm.r2 < 0.04
  union all select 'MMA-PLT' where mm.age >= 18 and mm.r3 < 0.09
  union all select (array['CD-06', 'CD-12', 'CD-12', 'CD-18', 'CD-24', 'CD-36', 'CD-60'])[1 + floor(random() * 7)::int]
            from generate_series(1, case when mm.age >= 18 and mm.r4 < 0.13 then 1 + floor(mm.r5 * 3)::int else 0 end)
  union all select 'IRA-TRD' where mm.age >= 18 and mm.r6 < 0.05
  union all select 'IRA-ROTH' where mm.age >= 18 and mm.r6 >= 0.05 and mm.r6 < 0.08
  union all select 'LN-AUTO' where mm.age >= 18 and mm.r9 < 0.16
  union all select 'LN-VISA' where mm.age >= 18 and mm.r10 < 0.18
  union all select 'LN-SIG' where mm.age >= 18 and mm.r11 < 0.05
  union all select 'LN-HELOC' where mm.age >= 25 and mm.r12 < 0.03
  union all select 'LN-MORT' where mm.age >= 25 and mm.r13 < 0.06
) x;

insert into core.accounts (
  member_id, suffix, product_code, nickname, status, opened_on, closed_on,
  current_balance, available_balance, hold_amount, rate, term_months, maturity_date,
  maturity_option, dividend_disposition, original_amount, credit_limit, payment_amount,
  next_payment_due, statement_delivery, debit_card_ordered, opened_by_id, opened_by_name,
  branch_id, last_activity_on, created_at
)
with staff as (
  select array_agg(id order by username) as ids, array_agg(full_name order by username) as names
  from core.staff where role in ('member_service_rep', 'branch_manager') and is_active
),
former as (select items from seed.lists where name = 'former_staff'),
z as (
  select
    pl.member_id, pl.product_code,
    p.category, p.suffix_prefix, p.suffix_min, p.suffix_max, p.rate as product_rate, p.term_months as product_term,
    p.min_opening_deposit,
    m.member_since, m.status as member_status, m.closed_on as member_closed_on, m.primary_branch_id, m.e_statements,
    random() as ra, random() as rb, random() as rc, random() as rd, random() as re, random() as rf, random() as rg
  from seed.plan pl
  join core.products p on p.code = pl.product_code
  join core.members m on m.id = pl.member_id
),
o as (
  select z.*,
    case
      when z.product_code = 'SHR-MEM' then z.member_since
      when z.category = 'certificate' then greatest(z.member_since, date '2026-09-21' - floor(z.rb * z.product_term * 30.4)::int)
      when z.product_code = 'LN-MORT' then greatest(z.member_since, date '2026-09-21' - floor(z.rb * 25 * 365)::int)
      when z.product_code = 'LN-AUTO' then greatest(z.member_since, date '2026-09-21' - floor(z.rb * 70 * 30.4)::int)
      when z.product_code = 'LN-SIG' then greatest(z.member_since, date '2026-09-21' - floor(z.rb * 46 * 30.4)::int)
      when z.product_code = 'LN-HELOC' then greatest(z.member_since, date '2026-09-21' - floor(z.rb * 10 * 365)::int)
      else z.member_since + floor((date '2026-09-21' - z.member_since) * z.rb)::int
    end as opened_on
  from z
),
q as (
  select o.*,
    -- loan economics
    case o.product_code
      when 'LN-AUTO' then round((12000 + o.rc * 43000)::numeric, -2)
      when 'LN-SIG' then round((2000 + o.rc * 13000)::numeric, -2)
      when 'LN-MORT' then round((150000 + o.rc * 500000)::numeric, -3)
    end as original,
    case o.product_code when 'LN-AUTO' then case when o.rf < 0.5 then 60 else 72 end
                        when 'LN-SIG' then 48 when 'LN-MORT' then 360 end as loan_term,
    case when o.category = 'loan' then round((o.product_rate + (o.rd - 0.3) * 4)::numeric, 3)
         when o.category = 'certificate' then round(greatest(0.5, o.product_rate + (o.rd - 0.5) * 1.2)::numeric, 3)
         else o.product_rate end as acct_rate,
    ((date_part('year', age(date '2026-09-21', o.opened_on)) * 12) + date_part('month', age(date '2026-09-21', o.opened_on)))::int as months_open
  from o
),
r as (
  select q.*,
    -- suffixes are handed out in opening order, like the core system does
    row_number() over (partition by q.member_id, q.suffix_prefix, q.suffix_min order by q.opened_on, q.ra) as seq,
    case
      when q.member_status = 'closed' then 'closed'
      when q.member_status = 'deceased' then 'restricted'
      when q.category = 'loan' and q.loan_term is not null and q.months_open >= q.loan_term then 'closed'
      when q.category = 'loan' and q.re < 0.06 then 'closed'
      when q.product_code <> 'SHR-MEM' and q.category not in ('loan', 'certificate', 'ira') and q.re < 0.03 then 'closed'
      when q.member_status = 'dormant' and q.category in ('share', 'share_draft', 'club', 'money_market') then 'dormant'
      else 'open'
    end as acct_status,
    case when q.loan_term is not null then
      round(q.original * ((q.acct_rate / 1200) / (1 - power(1 + q.acct_rate / 1200, -q.loan_term)))::numeric, 2)
    end as amort_payment
  from q
)
select
  r.member_id,
  r.suffix_prefix || lpad((r.suffix_min + r.seq - 1)::text, 2, '0'),
  r.product_code,
  case when r.category in ('share', 'share_draft', 'club', 'money_market') and r.product_code <> 'SHR-MEM' and r.rg < 0.12
       then (array['Emergency fund', 'Vacation', 'House down payment', 'Bills', 'Car fund', 'Holiday savings', 'Rainy day',
                   'Tuition', 'Household', 'Wedding fund', 'College fund', 'New roof'])[1 + floor(r.rg / 0.12 * 12)::int] end,
  r.acct_status::core.account_status,
  r.opened_on,
  case when r.acct_status = 'closed' then
    coalesce(r.member_closed_on, least(date '2026-09-10', r.opened_on + 30 + floor((date '2026-09-10' - r.opened_on) * r.rf)::int)) end,
  -- current balance (deposits: target before ledger generation; loans: principal outstanding)
  case when r.acct_status = 'closed' then 0 else
    case r.product_code
      when 'SHR-MEM' then least(150000, 5 + round(exp(random_normal(6.0, 1.6))::numeric, 2))
      when 'SHR-REG' then least(250000, round(exp(random_normal(7.2, 1.5))::numeric, 2))
      when 'SHR-YTH' then least(20000, round(exp(random_normal(5.5, 1.0))::numeric, 2))
      when 'CLB-HOL' then least(15000, round(exp(random_normal(5.8, 0.9))::numeric, 2))
      when 'CLB-VAC' then least(15000, round(exp(random_normal(5.8, 0.9))::numeric, 2))
      when 'DFT-BAS' then least(60000, round(exp(random_normal(7.2, 1.1))::numeric, 2))
      when 'DFT-PRM' then least(100000, round(exp(random_normal(7.9, 1.0))::numeric, 2))
      when 'MMA-PLT' then least(500000, 2500 + round(exp(random_normal(9.3, 1.0))::numeric, 2))
      when 'IRA-TRD' then least(800000, round(exp(random_normal(9.5, 1.2))::numeric, 2))
      when 'IRA-ROTH' then least(400000, round(exp(random_normal(9.1, 1.1))::numeric, 2))
      when 'LN-VISA' then round(((1000 + floor(r.rc * 24) * 1000) * power(r.rd, 1.5) * 0.9)::numeric, 2)
      when 'LN-HELOC' then round(((25000 + floor(r.rc * 125) * 1000) * r.rd * 0.8)::numeric, 2)
      else case when r.category = 'certificate'
                then greatest(r.min_opening_deposit, least(400000, round(exp(random_normal(9.2, 1.0))::numeric, 2)))
                else greatest(0, round(r.original * (1 - power(r.months_open::numeric / r.loan_term, 1.3)), 2)) end
    end
  end,
  0, 0,
  r.acct_rate,
  case when r.category = 'certificate' then r.product_term when r.loan_term is not null then r.loan_term end,
  case when r.category = 'certificate' then (r.opened_on + make_interval(months => r.product_term))::date
       when r.loan_term is not null then (r.opened_on + make_interval(months => r.loan_term))::date end,
  case when r.category = 'certificate' then
    case when r.rf < 0.6 then 'renew' when r.rf < 0.9 then 'transfer_to_share' else 'mail_check' end end,
  case when r.category = 'certificate' then case when r.rg < 0.75 then 'compound' else 'transfer_to_share' end end,
  r.original,
  case r.product_code when 'LN-VISA' then (1000 + floor(r.rc * 24) * 1000)
                      when 'LN-HELOC' then (25000 + floor(r.rc * 125) * 1000) end,
  case when r.category = 'loan' and r.acct_status <> 'closed' then
    coalesce(r.amort_payment,
      case r.product_code when 'LN-VISA' then greatest(25, round(((1000 + floor(r.rc * 24) * 1000) * power(r.rd, 1.5) * 0.9 * 0.02)::numeric, 2))
                          when 'LN-HELOC' then greatest(100, round(((25000 + floor(r.rc * 125) * 1000) * r.rd * 0.8 * 0.015)::numeric, 2)) end) end,
  case when r.category = 'loan' and r.acct_status <> 'closed' then date '2026-09-23' + floor(r.re * 28)::int end,
  case when r.e_statements then 'electronic' else 'paper' end,
  case when r.category = 'share_draft' then r.rf < 0.9 end,
  case when r.opened_on >= date '2024-09-22' then s.ids[1 + floor(r.rg * array_length(s.ids, 1))::int]
       when r.opened_on >= date '2012-03-01' and r.rb < 0.5 then s.ids[1 + floor(r.rg * array_length(s.ids, 1))::int] end,
  case when r.opened_on < date '2012-03-01' then 'Core conversion (2012)'
       when r.opened_on >= date '2024-09-22' or r.rb < 0.5 then s.names[1 + floor(r.rg * array_length(s.ids, 1))::int]
       else f.items[1 + floor(r.rg * array_length(f.items, 1))::int] end,
  case when r.ra < 0.8 then r.primary_branch_id else (1 + r.member_id % 8)::smallint end,
  case when r.acct_status = 'dormant' then date '2026-09-21' - (400 + floor(r.rb * 1100)::int)
       when r.acct_status = 'closed' then null
       else date '2026-09-21' - floor(r.rb * 45)::int end,
  r.opened_on::timestamp + interval '11 hours'
from r
cross join staff s
cross join former f
where r.suffix_min + r.seq - 1 <= r.suffix_max;

select count(*) as accounts,
       count(*) filter (where status = 'open') as open,
       count(*) filter (where status = 'closed') as closed,
       count(*) filter (where product_code like 'LN-%') as loans,
       pg_size_pretty(pg_total_relation_size('core.accounts')) as size
from core.accounts;
