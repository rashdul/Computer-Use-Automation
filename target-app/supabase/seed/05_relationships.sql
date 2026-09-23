-- Households: spouses (same decade of birth, shared address, 70% shared
-- surname), minors linked to a parent, plus domestic and business partners.
select setseed(0.31);

drop table if exists seed.pairs;
create unlogged table seed.pairs as
with adults as (
  select id, row_number() over (order by date_trunc('decade', date_of_birth), random()) as k
  from core.members
  where status in ('active', 'dormant') and not is_restricted
    and date_of_birth <= date '2004-09-22'
    and membership_type = 'individual'
)
select a.id as a_id, b.id as b_id, random() < 0.7 as share_name, random() < 0.6 as joint_accounts
from adults a
join adults b on b.k = a.k + 1
where a.k % 2 = 1 and a.k <= 13000;

update core.members b set
  last_name = case when p.share_name then a.last_name else b.last_name end,
  address_line1 = a.address_line1,
  address_line2 = a.address_line2,
  city = a.city,
  state = a.state,
  postal_code = a.postal_code,
  primary_branch_id = a.primary_branch_id,
  phone_home = coalesce(a.phone_home, b.phone_home),
  membership_type = 'joint'
from seed.pairs p
join core.members a on a.id = p.a_id
where b.id = p.b_id;

update core.members a set membership_type = 'joint'
from seed.pairs p where a.id = p.a_id;

insert into core.member_relationships (member_id, related_member_id, relationship, created_at)
select a_id, b_id, 'Spouse', now() - (floor(random() * 3000)::int * interval '1 day') from seed.pairs
union all
select b_id, a_id, 'Spouse', now() - (floor(random() * 3000)::int * interval '1 day') from seed.pairs;

-- minors take a parent's surname and address
drop table if exists seed.minor_parent;
create unlogged table seed.minor_parent as
with minors as (
  select id, row_number() over (order by random()) as k from core.members where membership_type = 'minor'
),
parents as (
  select id, row_number() over (order by random()) as k
  from core.members
  where status = 'active' and not is_restricted
    and date_of_birth between date '1966-01-01' and date '1996-01-01'
)
select m.id as minor_id, p.id as parent_id
from minors m join parents p on p.k = m.k;

update core.members c set
  last_name = p.last_name,
  address_line1 = p.address_line1,
  address_line2 = p.address_line2,
  city = p.city,
  state = p.state,
  postal_code = p.postal_code,
  primary_branch_id = p.primary_branch_id,
  phone_home = p.phone_home
from seed.minor_parent mp
join core.members p on p.id = mp.parent_id
where c.id = mp.minor_id;

insert into core.member_relationships (member_id, related_member_id, relationship, created_at)
select minor_id, parent_id, 'Parent', now() - (floor(random() * 2000)::int * interval '1 day') from seed.minor_parent
union all
select parent_id, minor_id, 'Child', now() - (floor(random() * 2000)::int * interval '1 day') from seed.minor_parent
on conflict do nothing;

-- domestic and business partners (no address changes)
with pool as (
  select id, row_number() over (order by random()) as k
  from core.members
  where status = 'active' and membership_type = 'individual' and date_of_birth <= date '2004-09-22'
),
pp as (
  select a.id as a_id, b.id as b_id, case when a.k <= 1600 then 'Domestic partner' else 'Business partner' end as rel
  from pool a join pool b on b.k = a.k + 1
  where a.k % 2 = 1 and a.k <= 2400
)
insert into core.member_relationships (member_id, related_member_id, relationship, created_at)
select a_id, b_id, rel, now() - (floor(random() * 2500)::int * interval '1 day') from pp
union all
select b_id, a_id, rel, now() - (floor(random() * 2500)::int * interval '1 day') from pp
on conflict do nothing;

select relationship, count(*) from core.member_relationships group by relationship order by 2 desc;
