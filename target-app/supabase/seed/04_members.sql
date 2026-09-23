-- 50,000 synthetic members. Deterministic (setseed). Member numbers are
-- assigned in join-date order, like a real core system.
select setseed(0.2026);

drop table if exists seed.m;
create unlogged table seed.m as
with l as (
  select
    (select items from seed.lists where name = 'male') as male,
    (select items from seed.lists where name = 'female') as female,
    (select items from seed.lists where name = 'last') as last,
    (select items from seed.lists where name = 'streets') as streets,
    (select items from seed.lists where name = 'employers') as employers,
    (select items from seed.lists where name = 'occupations') as occupations,
    (select count(*) from seed.geo)::int as geo_n
),
g as materialized (
  select gs as rn,
    random() as r_sex, random() as r_first, random() as r_mid, random() as r_mid_has, random() as r_last,
    random() as r_suffix, random() as r_age, random() as r_dob, random() as r_since, random() as r_geo,
    random() as r_street, random() as r_stno, random() as r_apt, random() as r_email, random() as r_email_fmt,
    random() as r_email_dom, random() as r_mobile, random() as r_mobile_n, random() as r_home, random() as r_home_n,
    random() as r_status, random() as r_status_date, random() as r_kyc, random() as r_kyc_date, random() as r_risk,
    random() as r_restrict, random() as r_restrict_reason, random() as r_emp, random() as r_emp_pick, random() as r_occ,
    random() as r_iddoc, random() as r_idexp, random() as r_idl4, random() as r_contact, random() as r_estmt,
    random() as r_type, random() as r_area
  from generate_series(1, 50000) gs
),
a as (
  select g.*,
    case when g.r_age < 0.05 then 14 + floor(g.r_age / 0.05 * 4)::int
         else 18 + floor(power((g.r_age - 0.05) / 0.95, 1.25) * 72)::int end as age
  from g
),
b as (
  select a.*, (date '2026-09-22' - (a.age * 365.25 + floor(a.r_dob * 364))::int) as dob
  from a
),
c as (
  select b.*,
    case when b.age < 18 then b.dob + 30
         else greatest(date '1962-05-01', (b.dob + interval '18 years')::date) end as since_min
  from b
),
d as (
  select c.*,
    (c.since_min + floor((date '2026-09-20' - c.since_min) * power(c.r_since, 0.55))::int) as since,
    case when c.age < 18 then 'active'
         when c.r_status < 0.88 then 'active'
         when c.r_status < 0.94 then 'dormant'
         when c.r_status < 0.985 or c.age < 30 then 'closed'
         else 'deceased' end as status
  from c
)
select
  d.rn,
  d.age,
  d.dob,
  d.since,
  d.status,
  (d.r_sex < 0.52) as female,
  case when d.r_sex < 0.52 then l.female[1 + floor(d.r_first * array_length(l.female, 1))::int]
       else l.male[1 + floor(d.r_first * array_length(l.male, 1))::int] end as first_name,
  case when d.r_mid_has < 0.7 then
    case when d.r_sex < 0.52 then l.female[1 + floor(d.r_mid * array_length(l.female, 1))::int]
         else l.male[1 + floor(d.r_mid * array_length(l.male, 1))::int] end end as middle_name,
  l.last[1 + floor(d.r_last * array_length(l.last, 1))::int] as last_name,
  case when d.r_sex >= 0.52 and d.r_suffix < 0.035 and d.age >= 18
       then (array['Jr.', 'Sr.', 'II', 'III'])[1 + floor(d.r_suffix / 0.035 * 4)::int] end as name_suffix,
  (100 + floor(d.r_stno * 9800)::int)::text || ' ' || l.streets[1 + floor(d.r_street * array_length(l.streets, 1))::int] as address_line1,
  case when d.r_apt < 0.2 then 'Apt ' || (1 + floor(d.r_apt / 0.2 * 40)::int)::text
                                       || (array['A', 'B', 'C', 'D'])[1 + floor(d.r_stno * 4)::int] end as address_line2,
  geo.city, geo.state, geo.zip as postal_code,
  coalesce(geo.branch_id, (1 + floor(d.r_geo * 8))::smallint) as branch_id,
  geo.area_codes[1 + floor(d.r_area * array_length(geo.area_codes, 1))::int] as area_code,
  d.r_email, d.r_email_fmt, d.r_email_dom, d.r_mobile, d.r_mobile_n, d.r_home, d.r_home_n,
  d.r_status_date, d.r_kyc, d.r_kyc_date, d.r_risk, d.r_restrict, d.r_restrict_reason,
  d.r_emp, d.r_emp_pick, d.r_occ, d.r_iddoc, d.r_idexp, d.r_idl4, d.r_contact, d.r_estmt, d.r_type,
  l.employers[1 + floor(d.r_emp_pick * array_length(l.employers, 1))::int] as employer_pick,
  l.occupations[1 + floor(d.r_occ * array_length(l.occupations, 1))::int] as occupation_pick
from d
cross join l
cross join lateral (select * from seed.geo gg where gg.idx = 1 + floor(d.r_geo * l.geo_n)::int) geo;

insert into core.members (
  member_number, first_name, middle_name, last_name, name_suffix, date_of_birth, ssn,
  email, phone_mobile, phone_home, address_line1, address_line2, city, state, postal_code,
  member_since, status, membership_type, primary_branch_id, employer, occupation,
  id_document_type, id_document_state, id_document_last4, id_document_expires_on,
  kyc_status, kyc_verified_on, risk_rating, is_restricted, restriction_reason,
  e_statements, preferred_contact, deceased_on, closed_on, created_at, updated_at
)
select
  (1000000 + sum(x.gap) over (order by x.since, x.rn))::text as member_number,
  x.first_name, x.middle_name, x.last_name, x.name_suffix, x.dob,
  -- unique by construction: rn -> x is a bijection mod 50,000,000
  '9' || lpad((x.p % 100)::text, 2, '0') || lpad(((x.p / 100) % 50)::text, 2, '0') || lpad(((x.p / 5000) % 10000)::text, 4, '0'),
  x.email,
  case when x.r_mobile < 0.94 then x.area_code || '555' || lpad(floor(x.r_mobile_n * 10000)::int::text, 4, '0') end,
  case when x.r_home < 0.35 then x.area_code || '555' || lpad(floor(x.r_home_n * 10000)::int::text, 4, '0') end,
  x.address_line1, x.address_line2, x.city, x.state, x.postal_code,
  x.since, x.status::core.member_status,
  case when x.age < 18 then 'minor' when x.r_type < 0.02 then 'trust' else 'individual' end::core.membership_type,
  x.branch_id,
  case when x.age < 18 then null
       when x.age >= 67 and x.r_emp < 0.8 then 'Retired'
       when x.r_emp < 0.9 then x.employer_pick end,
  case when x.age < 18 then 'Student'
       when x.age >= 67 and x.r_emp < 0.8 then 'Retired'
       when x.r_emp < 0.9 then x.occupation_pick end,
  case when x.age < 18 and x.r_iddoc < 0.6 then 'U.S. passport'
       when x.age < 18 then 'State ID'
       when x.r_iddoc < 0.72 then 'Driver license'
       when x.r_iddoc < 0.83 then 'State ID'
       when x.r_iddoc < 0.97 then 'U.S. passport'
       else 'Military ID' end,
  case when x.r_iddoc < 0.83 and x.age >= 18 then x.state end,
  lpad(floor(x.r_idl4 * 10000)::int::text, 4, '0'),
  (date '2026-01-01' + floor(x.r_idexp * 3650)::int),
  case when x.age < 18 or x.status in ('closed', 'deceased') or x.r_kyc < 0.93 then 'verified'
       when x.r_kyc < 0.955 then 'pending_review'
       when x.r_kyc < 0.99 then 'expired'
       else 'failed' end::core.kyc_status,
  (x.since + floor((date '2026-09-20' - x.since) * x.r_kyc_date)::int),
  case when x.r_risk < 0.85 then 'low' when x.r_risk < 0.97 then 'moderate' else 'high' end::core.risk_rating,
  (x.r_restrict < 0.006 and x.age >= 21 and x.status in ('active', 'dormant')),
  case when x.r_restrict < 0.006 and x.age >= 21 and x.status in ('active', 'dormant') then
    case when x.r_restrict_reason < 0.45 then 'Employee account'
         when x.r_restrict_reason < 0.55 then 'Board of directors (Reg O insider)'
         when x.r_restrict_reason < 0.80 then 'Legal hold'
         else 'Fraud investigation' end end,
  (x.email is not null and x.r_estmt < 0.7),
  case when x.email is not null and x.r_contact < 0.45 then 'email'
       when x.r_mobile < 0.94 and x.r_contact < 0.80 then 'mobile'
       when x.r_home < 0.35 and x.r_contact < 0.88 then 'home_phone'
       else 'mail' end,
  case when x.status = 'deceased' then greatest(x.since + 60, date '2026-09-20' - floor(x.r_status_date * 900)::int) end,
  case when x.status = 'closed' then least(date '2026-09-15', x.since + 30 + floor((date '2026-09-15' - x.since) * x.r_status_date)::int) end,
  x.since::timestamp + interval '10 hours',
  now() - (floor(x.r_status_date * 400)::int * interval '1 day')
from (
  select m.*,
    1 + floor(random() * 11)::int as gap,
    (m.rn::bigint * 104729) % 50000000 as p,
    case when m.r_email < case when m.age < 18 then 0.4 else 0.72 end then
      lower(regexp_replace(m.first_name, '[^A-Za-z]', '', 'g'))
      || case when m.r_email_fmt < 0.45 then '.' || lower(regexp_replace(m.last_name, '[^A-Za-z]', '', 'g'))
              when m.r_email_fmt < 0.75 then lower(left(regexp_replace(m.last_name, '[^A-Za-z]', '', 'g'), 1))
              else '_' || lower(regexp_replace(m.last_name, '[^A-Za-z]', '', 'g')) end
      || case when m.r_email_fmt < 0.6 then lpad(floor(m.r_email_dom * 100)::int::text, 2, '0')
              else extract(year from m.dob)::int::text end
      || (array['@example.com', '@example.net', '@example.org'])[1 + floor(m.r_email_dom * 3)::int]
    end as email
  from seed.m m
) x
order by x.since, x.rn;

select count(*) as members,
       count(*) filter (where status = 'active') as active,
       count(*) filter (where is_restricted) as restricted,
       count(*) filter (where membership_type = 'minor') as minors,
       min(member_number) as first_number, max(member_number) as last_number,
       count(distinct ssn) as distinct_ssn,
       pg_size_pretty(pg_total_relation_size('core.members')) as size
from core.members;
