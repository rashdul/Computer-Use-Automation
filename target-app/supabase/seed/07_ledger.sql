-- Posted ledger for 1 Jul – 22 Sep 2026, generated per batch of members so
-- that transfers between a member's own accounts post on both sides.
-- For each account the generator works out a balance forward that keeps the
-- running balance above its floor ($5 par on S00, $0 elsewhere) and lands the
-- current balance on the account's target, then writes balance_after on
-- every row.  Usage:  select seed.generate_ledger(1, 10000);

create or replace function seed.at(p_day date, p_hours double precision)
returns timestamptz
language sql
immutable
as $$
  select (p_day + p_hours * interval '1 hour') at time zone 'America/New_York'
$$;

drop table if exists seed.txn;
create unlogged table seed.txn (
  seq         bigserial,
  account_id  bigint not null,
  posted_at   timestamptz not null,
  amount      numeric(14, 2) not null,
  txn_type    core.txn_type not null,
  channel     core.txn_channel not null,
  description text not null,
  reference   text,
  hold        numeric(14, 2) not null default 0
);

create or replace function seed.generate_ledger(p_lo bigint, p_hi bigint)
returns jsonb
language plpgsql
as $$
declare
  w0 constant date := date '2026-07-01';
  w1 constant date := date '2026-09-21';
  v_txns bigint;
  v_accounts bigint;
begin
  truncate seed.txn;

  drop table if exists seed.ba;
  create unlogged table seed.ba as
  select a.id, a.member_id, a.suffix, a.product_code, p.category, a.status, a.opened_on,
         a.current_balance as target, a.rate, a.payment_amount, a.next_payment_due, a.credit_limit,
         a.dividend_disposition, m.member_number, m.employer,
         case when a.product_code = 'SHR-MEM' then 5.00 else 0 end::numeric as floor_amt,
         (a.opened_on >= w0) as in_window
  from core.accounts a
  join core.products p on p.code = a.product_code
  join core.members m on m.id = a.member_id
  where a.member_id between p_lo and p_hi and a.status <> 'closed';
  create index on seed.ba (id);

  -- per-member anchors for internal transfers
  drop table if exists seed.bm;
  create unlogged table seed.bm as
  select b.member_id, max(b.member_number) as member_number,
    (array_agg(b.id order by b.suffix) filter (where b.product_code = 'SHR-MEM' and b.status = 'open'))[1] as s00_id,
    (array_agg(b.opened_on order by b.suffix) filter (where b.product_code = 'SHR-MEM' and b.status = 'open'))[1] as s00_opened,
    (array_agg(b.id order by b.suffix) filter (where b.product_code = 'SHR-REG' and b.status = 'open'))[1] as s01_id,
    (array_agg(b.suffix order by b.suffix) filter (where b.product_code = 'SHR-REG' and b.status = 'open'))[1] as s01_suffix,
    (array_agg(b.opened_on order by b.suffix) filter (where b.product_code = 'SHR-REG' and b.status = 'open'))[1] as s01_opened,
    (array_agg(b.id order by b.suffix) filter (where b.category = 'share_draft' and b.status = 'open'))[1] as d_id,
    (array_agg(b.suffix order by b.suffix) filter (where b.category = 'share_draft' and b.status = 'open'))[1] as d_suffix,
    (array_agg(b.opened_on order by b.suffix) filter (where b.category = 'share_draft' and b.status = 'open'))[1] as d_opened
  from seed.ba b
  group by b.member_id;

  -- checking: payroll every other week -------------------------------------------------
  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description)
  select a.id, seed.at(d::date, 5 + random() * 2), round(a.pay * (0.97 + random() * 0.06)::numeric, 2),
         'ach_credit', 'ach', 'PAYROLL DIRECT DEP ' || a.payer
  from (
    select ba.*, exp(random_normal(7.35, 0.45))::numeric as pay,
           upper(left(regexp_replace(ba.employer, '[^A-Za-z0-9 &]', '', 'g'), 24)) as payer
    from seed.ba ba
    where ba.category = 'share_draft' and ba.status = 'open' and ba.employer is not null
      and ba.employer not in ('Retired', 'Self-employed') and (ba.id % 100) < 88
  ) a
  cross join lateral generate_series((w0 + (a.id % 14)::int)::timestamp, w1::timestamp, interval '14 days') d
  where d::date > a.opened_on;

  -- checking: Social Security for retirees ------------------------------------------------
  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description)
  select a.id, seed.at(v.d, 4.5), a.ss, 'ach_credit', 'ach', 'SSA TREAS 310 XXSOC SEC'
  from (
    select ba.*, round((1150 + random() * 2300)::numeric, 2) as ss
    from seed.ba ba
    where ba.category = 'share_draft' and ba.status = 'open' and ba.employer = 'Retired'
  ) a
  cross join (values (date '2026-07-03'), (date '2026-08-03'), (date '2026-09-03')) v(d)
  where v.d > a.opened_on;

  -- checking: card purchases ---------------------------------------------------------------
  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description)
  select x.id, seed.at(x.d, 8 + random() * 13),
         -greatest(1.00, round(exp(random_normal(3.3, 0.85))::numeric, 2)),
         'card_purchase', 'card',
         'POS PURCHASE ' || m.items[1 + floor(random() * array_length(m.items, 1))::int]
  from (
    select a.id, a.opened_on, (w0 + floor(random() * (w1 - w0 + 1))::int) as d
    from seed.ba a
    cross join lateral generate_series(1, 5 + floor(random() * 12)::int + 0 * a.id::int) k
    where a.category = 'share_draft' and a.status = 'open'
  ) x
  cross join (select items from seed.lists where name = 'merchants') m
  where x.d > x.opened_on;

  -- checking: recurring bills ------------------------------------------------------------------
  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description)
  select a.id, seed.at(make_date(2026, mo.m, bl.day), 3.5), -bl.amt, 'ach_debit', 'ach', b.items[bl.bi]
  from seed.ba a
  cross join lateral (
    select k,
           1 + ((a.id * 7919 + k * 104729) % 15)::int as bi,
           1 + ((a.id + k * 9) % 27)::int as day,
           round((35 + ((a.id * k) % 190) + random() * 15)::numeric, 2) as amt
    from generate_series(1, 2 + (a.id % 2)::int) k
  ) bl
  cross join (values (7), (8), (9)) mo(m)
  cross join (select items from seed.lists where name = 'billers') b
  where a.category = 'share_draft' and a.status = 'open'
    and make_date(2026, mo.m, bl.day) > a.opened_on
    and make_date(2026, mo.m, bl.day) <= w1;

  -- checking: ATM withdrawals (foreign ATMs add a surcharge) ----------------------------------------
  drop table if exists seed.atm;
  create unlogged table seed.atm as
  select x.id, seed.at(x.d, 9 + random() * 12) as at, (20 * (2 + floor(random() * 14)))::numeric as amt, random() < 0.25 as foreign_atm
  from (
    select a.id, a.opened_on, (w0 + floor(random() * (w1 - w0 + 1))::int) as d
    from seed.ba a
    cross join lateral generate_series(1, floor(random() * 3)::int + 0 * a.id::int) k
    where a.category = 'share_draft' and a.status = 'open'
  ) x
  where x.d > x.opened_on;

  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description)
  select id, at, -amt, 'atm_withdrawal'::core.txn_type, 'atm'::core.txn_channel,
         case when foreign_atm then 'ATM WITHDRAWAL 7-ELEVEN #' || (3000 + id % 900)
              else 'ATM WITHDRAWAL RFCU ' || (array['BALTIMORE MAIN', 'TOWSON', 'COLUMBIA', 'ANNAPOLIS', 'SILVER SPRING', 'K STREET', 'ARLINGTON', 'GLEN BURNIE'])[1 + (id % 8)::int] end
  from seed.atm
  union all
  select id, at + interval '1 minute', -3.00, 'fee'::core.txn_type, 'atm'::core.txn_channel, 'NON-NETWORK ATM FEE'
  from seed.atm where foreign_atm;

  -- checking: checks paid and mobile deposits --------------------------------------------------------
  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description, reference)
  select x.id, seed.at(x.d, 2 + random() * 3), -round((50 + random() * 1150)::numeric, 2), 'check_paid', 'system',
         'CHECK #' || x.chk, x.chk
  from (
    select a.id, a.opened_on, (w0 + floor(random() * (w1 - w0 + 1))::int) as d, (1001 + floor(random() * 400)::int)::text as chk
    from seed.ba a
    where a.category = 'share_draft' and a.status = 'open' and random() < 0.3
  ) x
  where x.d > x.opened_on;

  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description, hold)
  select x.id, seed.at(x.d, 10 + random() * 10), x.amt, 'check_deposit', 'mobile', 'MOBILE CHECK DEPOSIT',
         case when x.d >= date '2026-09-20' then greatest(x.amt - 225, 0) else 0 end
  from (
    select a.id, a.opened_on, (w0 + floor(random() * (w1 - w0 + 1))::int) as d, round((80 + random() * 1500)::numeric, 2) as amt
    from seed.ba a
    where a.category = 'share_draft' and a.status = 'open' and random() < 0.28
  ) x
  where x.d > x.opened_on;

  -- checking -> regular share, monthly on the 15th (both sides) ---------------------------------------
  with pairs as (
    select bm.*, round((50 + floor(random() * 10) * 50)::numeric, 2) as amt
    from seed.bm bm
    where bm.d_id is not null and bm.s01_id is not null and random() < 0.35
  )
  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description)
  select p.d_id, seed.at(make_date(2026, mo.m, 15), 7), -p.amt, 'transfer_out'::core.txn_type, 'online'::core.txn_channel,
         'ONLINE TRANSFER TO ' || p.member_number || '-' || p.s01_suffix
  from pairs p cross join (values (7), (8), (9)) mo(m)
  where make_date(2026, mo.m, 15) > greatest(p.d_opened, p.s01_opened)
  union all
  select p.s01_id, seed.at(make_date(2026, mo.m, 15), 7.001), p.amt, 'transfer_in'::core.txn_type, 'online'::core.txn_channel,
         'ONLINE TRANSFER FROM ' || p.member_number || '-' || p.d_suffix
  from pairs p cross join (values (7), (8), (9)) mo(m)
  where make_date(2026, mo.m, 15) > greatest(p.d_opened, p.s01_opened);

  -- Premier Checking fee when under the $2,500 balance requirement -----------------------------------
  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description)
  select a.id, seed.at(v.d, 22), -6.00, 'fee', 'system', 'MONTHLY SERVICE FEE'
  from seed.ba a
  cross join (values (date '2026-07-31'), (date '2026-08-31')) v(d)
  where a.product_code = 'DFT-PRM' and a.status = 'open' and a.target < 2500 and v.d > a.opened_on;

  -- dividends at month end -------------------------------------------------------------------------------
  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description)
  select a.id, seed.at(v.d, 23), round(a.target * a.rate / 1200, 2), 'dividend', 'system',
         'DIVIDEND EARNED ' || to_char(date_trunc('month', v.d), 'MM/DD') || '–' || to_char(v.d, 'MM/DD')
  from seed.ba a
  cross join (values (date '2026-07-31'), (date '2026-08-31')) v(d)
  where v.d > a.opened_on
    and a.rate > 0
    and round(a.target * a.rate / 1200, 2) >= 0.01
    and (a.category in ('share', 'club', 'money_market', 'ira')
         or (a.category = 'certificate' and a.dividend_disposition = 'compound')
         or a.product_code = 'DFT-PRM');

  -- savings & money market activity ------------------------------------------------------------------------
  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description)
  select x.id, seed.at(x.d, 9 + random() * 8),
         case when x.kind < 0.35 then x.amt when x.kind < 0.55 then round(x.amt * 1.4, 2) else -x.amt end,
         (case when x.kind < 0.35 then 'deposit' when x.kind < 0.55 then 'check_deposit' else 'withdrawal' end)::core.txn_type,
         (case when x.kind < 0.35 then 'branch' when x.kind < 0.55 then 'mobile' else 'branch' end)::core.txn_channel,
         case when x.kind < 0.35 then 'DEPOSIT · BRANCH' when x.kind < 0.55 then 'MOBILE CHECK DEPOSIT' else 'WITHDRAWAL · BRANCH' end
  from (
    select a.id, a.opened_on, (w0 + floor(random() * (w1 - w0 + 1))::int) as d, random() as kind,
           round(case when a.category = 'money_market' then 500 + random() * 4500 else 20 + random() * 780 end::numeric, 2) as amt
    from seed.ba a
    cross join lateral generate_series(1, floor(random() * 3)::int + 0 * a.id::int) k
    where a.status = 'open' and (a.product_code in ('SHR-MEM', 'SHR-REG', 'SHR-YTH') or a.category = 'money_market')
  ) x
  where x.d > x.opened_on;

  -- clubs: monthly auto-transfer from S00 (both sides) -----------------------------------------------------
  with c as (
    select a.id, a.suffix, a.opened_on, bm.s00_id, bm.s00_opened, bm.member_number,
           round((25 + floor(random() * 8) * 25)::numeric, 2) as amt
    from seed.ba a join seed.bm bm on bm.member_id = a.member_id
    where a.category = 'club' and a.status = 'open' and bm.s00_id is not null
  )
  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description)
  select c.id, seed.at(make_date(2026, mo.m, 15), 6), c.amt, 'transfer_in'::core.txn_type, 'system'::core.txn_channel,
         'CLUB AUTO TRANSFER FROM ' || c.member_number || '-S00'
  from c cross join (values (7), (8), (9)) mo(m)
  where make_date(2026, mo.m, 15) > greatest(c.opened_on, c.s00_opened)
  union all
  select c.s00_id, seed.at(make_date(2026, mo.m, 15), 5.999), -c.amt, 'transfer_out'::core.txn_type, 'system'::core.txn_channel,
         'CLUB AUTO TRANSFER TO ' || c.member_number || '-' || c.suffix
  from c cross join (values (7), (8), (9)) mo(m)
  where make_date(2026, mo.m, 15) > greatest(c.opened_on, c.s00_opened);

  -- IRA contributions ---------------------------------------------------------------------------------------
  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description)
  select x.id, seed.at(x.d, 11 + random() * 5), round((200 + random() * 5800)::numeric, 2), 'deposit', 'branch',
         'IRA CONTRIBUTION · TAX YEAR 2026'
  from (
    select a.id, a.opened_on, (w0 + floor(random() * (w1 - w0 + 1))::int) as d
    from seed.ba a where a.category = 'ira' and a.status = 'open' and random() < 0.3
  ) x
  where x.d > x.opened_on;

  -- instalment loans: interest accrual + payment (autopay from checking posts both sides) -----------------
  drop table if exists seed.lp;
  create unlogged table seed.lp as
  select a.id, a.suffix, a.product_code, a.target, a.rate, a.payment_amount, bm.member_number, bm.d_id, bm.d_suffix, bm.d_opened,
         make_date(2026, mo.m, least(28, extract(day from a.next_payment_due)::int)) as due,
         (bm.d_id is not null and (a.id % 10) < 6) as autopay
  from seed.ba a
  join seed.bm bm on bm.member_id = a.member_id
  cross join (values (7), (8), (9)) mo(m)
  where a.category = 'loan' and a.status = 'open' and a.payment_amount is not null;

  delete from seed.lp l
  using seed.ba a
  where a.id = l.id and (l.due <= a.opened_on or l.due > w1 or (l.autopay and l.due <= l.d_opened));

  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description)
  select l.id, seed.at(l.due, 0.05), round(l.target * l.rate / 1200, 2), 'interest_charge', 'system', 'INTEREST CHARGED'
  from seed.lp l
  where round(l.target * l.rate / 1200, 2) >= 0.01;

  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description)
  select l.id, seed.at(l.due, 6),
         -case when l.product_code = 'LN-VISA' then greatest(l.payment_amount, round(l.target * 0.18, 2)) else l.payment_amount end,
         'loan_payment'::core.txn_type, (case when l.autopay then 'ach' else 'online' end)::core.txn_channel,
         case when l.autopay then 'AUTOPAY FROM ' || l.member_number || '-' || l.d_suffix else 'PAYMENT · ONLINE BANKING' end
  from seed.lp l
  union all
  select l.d_id, seed.at(l.due, 5.99),
         -case when l.product_code = 'LN-VISA' then greatest(l.payment_amount, round(l.target * 0.18, 2)) else l.payment_amount end,
         'transfer_out'::core.txn_type, 'ach'::core.txn_channel, 'LOAN PAYMENT TO ' || l.member_number || '-' || l.suffix
  from seed.lp l
  where l.autopay;

  -- Visa: purchases; HELOC: occasional advances ---------------------------------------------------------------
  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description)
  select x.id, seed.at(x.d, 8 + random() * 13), greatest(1.00, round(exp(random_normal(3.6, 0.9))::numeric, 2)),
         'card_purchase', 'card', 'PURCHASE ' || m.items[1 + floor(random() * array_length(m.items, 1))::int]
  from (
    select a.id, a.opened_on, (w0 + floor(random() * (w1 - w0 + 1))::int) as d
    from seed.ba a
    cross join lateral generate_series(1, 2 + floor(random() * 7)::int + 0 * a.id::int) k
    where a.product_code = 'LN-VISA' and a.status = 'open'
  ) x
  cross join (select items from seed.lists where name = 'merchants') m
  where x.d > x.opened_on;

  insert into seed.txn (account_id, posted_at, amount, txn_type, channel, description)
  select x.id, seed.at(x.d, 13), round((2000 + floor(random() * 20) * 500)::numeric, 2), 'loan_disbursement', 'online', 'HELOC ADVANCE · ONLINE'
  from (
    select a.id, a.opened_on, (w0 + floor(random() * (w1 - w0 + 1))::int) as d
    from seed.ba a where a.product_code = 'LN-HELOC' and a.status = 'open' and random() < 0.12
  ) x
  where x.d > x.opened_on;

  -- balances ---------------------------------------------------------------------------------------------------
  drop table if exists seed.fw;
  create unlogged table seed.fw as
  with t as (
    select s.account_id, s.amount, s.posted_at,
           sum(s.amount) over (partition by s.account_id order by s.posted_at, s.seq) as run
    from seed.txn s
  ),
  g as (
    select account_id, sum(amount) as total, least(min(run), 0) as min_run,
           max(posted_at) as last_at
    from t group by account_id
  )
  select a.id, a.in_window, a.category, a.product_code, a.opened_on, a.credit_limit, a.status,
         coalesce(g.total, 0) as total,
         g.last_at,
         greatest(a.target - coalesce(g.total, 0), a.floor_amt - coalesce(g.min_run, 0)) as start_bal
  from seed.ba a left join g on g.account_id = a.id;
  update seed.fw set start_bal = greatest(start_bal, 1.00) where in_window;
  create index on seed.fw (id);

  insert into core.transactions (account_id, posted_at, amount, balance_after, txn_type, channel, status, description, reference)
  select f.id, seed.at(f.opened_on, 10 + random() * 6), f.start_bal, f.start_bal,
         (case f.category when 'loan' then 'loan_disbursement' when 'certificate' then 'transfer_in' else 'deposit' end)::core.txn_type,
         (case f.category when 'loan' then 'system' else 'branch' end)::core.txn_channel,
         'posted'::core.txn_status,
         case f.category when 'loan' then 'LOAN DISBURSEMENT'
                         when 'certificate' then 'CERTIFICATE PURCHASE · FUNDS TRANSFERRED'
                         when 'ira' then 'IRA INITIAL CONTRIBUTION'
                         else 'OPENING DEPOSIT · BRANCH' end,
         null
  from seed.fw f
  where f.in_window
  union all
  select s.account_id, s.posted_at, s.amount,
         f.start_bal + sum(s.amount) over (partition by s.account_id order by s.posted_at, s.seq),
         s.txn_type, s.channel, 'posted'::core.txn_status, s.description, s.reference
  from seed.txn s join seed.fw f on f.id = s.account_id;
  get diagnostics v_txns = row_count;

  update core.accounts ac set
    current_balance = f.start_bal + f.total,
    hold_amount = coalesce(h.hold, 0),
    available_balance = case
      when f.category = 'loan' and f.credit_limit is not null then greatest(f.credit_limit - (f.start_bal + f.total), 0)
      when f.category = 'loan' then 0
      else f.start_bal + f.total - coalesce(h.hold, 0) end,
    last_activity_on = case when f.status = 'open' then coalesce((f.last_at at time zone 'America/New_York')::date, ac.last_activity_on)
                            else ac.last_activity_on end
  from seed.fw f
  left join (select account_id, sum(hold) as hold from seed.txn group by account_id) h on h.account_id = f.id
  where ac.id = f.id;
  get diagnostics v_accounts = row_count;

  return jsonb_build_object('members', jsonb_build_array(p_lo, p_hi), 'transactions', v_txns, 'accounts', v_accounts);
end
$$;
