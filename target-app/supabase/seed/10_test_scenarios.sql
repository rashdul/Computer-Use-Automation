-- Test-data catalogue: one deterministic member per runtime condition.
-- Each fixture is chosen by predicate so it has exactly the property it tests.

drop table if exists seed.cand;
create unlogged table seed.cand as
select m.id, m.member_number, m.status, m.kyc_status, m.is_restricted, m.restriction_reason, m.email,
       m.membership_type, m.member_since,
       private.age_on(m.date_of_birth, date '2026-09-22') as age,
       exists (select 1 from core.member_alerts al where al.member_id = m.id and al.resolved_at is null) as has_alert,
       (select array_agg(al.alert_type::text) from core.member_alerts al where al.member_id = m.id and al.resolved_at is null) as alerts,
       (select a.available_balance from core.accounts a where a.member_id = m.id and a.suffix = 'S00' and a.status = 'open') as s00_avail,
       (select count(*) from core.accounts a where a.member_id = m.id and a.status <> 'closed') as open_accts,
       (select coalesce(sum(a.available_balance), 0) from core.accounts a join core.products p on p.code = a.product_code
         where a.member_id = m.id and a.status = 'open' and p.category in ('share', 'share_draft', 'money_market') and a.suffix <> 'S00') as other_liquid,
       exists (select 1 from core.accounts a where a.member_id = m.id and a.product_code in ('DFT-BAS', 'DFT-PRM') and a.status = 'open') as has_checking,
       exists (select 1 from core.accounts a where a.member_id = m.id and a.product_code = 'CD-12' and a.status <> 'closed') as has_cd12,
       exists (select 1 from core.member_relationships r join core.members s on s.id = r.related_member_id
               where r.member_id = m.id and r.relationship = 'Spouse' and s.status = 'active' and s.kyc_status = 'verified'
                 and not s.is_restricted and private.age_on(s.date_of_birth, date '2026-09-22') >= 18) as has_eligible_spouse
from core.members m;

create or replace function seed.pick(p_where text)
returns text
language plpgsql
as $$
declare v text;
begin
  execute 'select member_number from seed.cand where ' || p_where || ' order by member_number limit 1' into v;
  return v;
end
$$;

truncate core.test_scenarios;

insert into core.test_scenarios (key, title, description, member_number, sign_in_as, expected_outcome, sort_order) values
('happy_path', 'Open a sub-account (happy path)',
 'Clean, verified member with a large S00 balance and checking. Open a 12-Month Share Certificate funded by transfer from S00.',
 seed.pick($w$status = 'active' and kyc_status = 'verified' and not is_restricted and not has_alert and age between 30 and 65
            and email is not null and s00_avail >= 20000 and has_checking and not has_cd12 and membership_type = 'individual'$w$),
 'aokafor', 'Confirmation page with a new C-suffix account number and an OA confirmation number.', 10),

('joint_owner', 'Joint ownership',
 'Member whose spouse is an eligible joint owner. Open Regular Share Savings with the spouse as joint owner.',
 seed.pick($w$status = 'active' and kyc_status = 'verified' and not is_restricted and not has_alert and has_eligible_spouse
            and email is not null and s00_avail >= 1000$w$),
 'aokafor', 'Account opens with the spouse listed as joint owner on the receipt.', 20),

('member_not_found', 'Member not found',
 'A well-formed member number that does not exist.', '9999999', 'aokafor',
 'Search shows no results; /members/9999999 shows the "Member not found" page.', 30),

('restricted_record', 'Restricted record (employee account)',
 'Employee account. Tellers, member service reps, and administrators are blocked; branch managers and compliance can open it.',
 seed.pick($w$is_restricted and restriction_reason = 'Employee account' and status = 'active'$w$),
 'aokafor', 'Search lists the member as restricted; opening the record shows "Permission denied" with an AUD reference.', 40),

('legal_hold', 'Legal hold',
 'Restricted record under legal hold. Branch managers can view it but account opening is blocked.',
 seed.pick($w$is_restricted and restriction_reason = 'Legal hold' and status = 'active' and kyc_status = 'verified'$w$),
 'mreyes', 'Record opens for a branch manager; Open sub-account is blocked by the legal hold.', 50),

('teller_cannot_open', 'Teller cannot open accounts',
 'Sign in as a teller and try to open a sub-account for the happy-path member.',
 seed.pick($w$status = 'active' and kyc_status = 'verified' and not is_restricted and not has_alert and age between 30 and 65
            and email is not null and s00_avail >= 20000 and has_checking and not has_cd12 and membership_type = 'individual'$w$),
 'jlin', 'Open sub-account shows "Permission denied" (Open sub-accounts permission).', 60),

('admin_segregation', 'Administrators cannot transact',
 'Segregation of duties: System Administrators manage access but cannot open accounts.',
 seed.pick($w$status = 'active' and kyc_status = 'verified' and not is_restricted and not has_alert and age between 30 and 65
            and email is not null and s00_avail >= 20000 and has_checking and not has_cd12 and membership_type = 'individual'$w$),
 'dwhitfield', 'Open sub-account shows "Permission denied".', 70),

('deceased', 'Deceased member',
 'Membership is marked deceased; accounts are frozen.',
 seed.pick($w$status = 'deceased' and not is_restricted$w$),
 'aokafor', 'Member page shows a critical alert; Open sub-account is blocked with "Member is deceased".', 80),

('ofac_review', 'OFAC review pending',
 'Otherwise clean member with an open OFAC screening match.',
 seed.pick($w$status = 'active' and kyc_status = 'verified' and not is_restricted and alerts = array['ofac_review']$w$),
 'aokafor', 'Account opening is blocked until Compliance clears the OFAC review.', 90),

('cip_expired', 'Identity verification expired',
 'Active member whose CIP verification has expired.',
 seed.pick($w$status = 'active' and kyc_status = 'expired' and not is_restricted and not has_alert$w$),
 'aokafor', 'Account opening is blocked: re-verify the member''s ID first.', 100),

('dormant', 'Dormant membership',
 'Dormant membership; new sub-accounts need reactivation first.',
 seed.pick($w$status = 'dormant' and not is_restricted and not has_alert$w$),
 'aokafor', 'Account opening is blocked: reactivate the membership first.', 110),

('no_email', 'No email on file',
 'Clean member without an email address. Choosing electronic statements fails validation.',
 seed.pick($w$status = 'active' and kyc_status = 'verified' and not is_restricted and not has_alert and age >= 18
            and email is null and s00_avail >= 1500$w$),
 'aokafor', 'Validation error on Statement delivery: "No email address on file…".', 120),

('insufficient_funds', 'Insufficient funds for transfer',
 'Clean member whose S00 holds only a small balance. Funding a certificate from S00 fails validation.',
 seed.pick($w$status = 'active' and kyc_status = 'verified' and not is_restricted and not has_alert and age >= 18
            and email is not null and s00_avail between 6 and 60 and other_liquid < 100$w$),
 'aokafor', 'Validation error on the deposit amount citing S00''s available balance.', 130),

('minor', 'Minor member',
 'Member under 18 with a custodian. Certificates and IRAs are not available.',
 seed.pick($w$membership_type = 'minor' and status = 'active' and not has_alert$w$),
 'aokafor', 'Product list shows certificates and IRAs as unavailable with the age requirement.', 140),

('duplicate_product', 'Duplicate product confirmation',
 'Member who already holds a 12-Month Share Certificate. Opening another asks for confirmation.',
 seed.pick($w$status = 'active' and kyc_status = 'verified' and not is_restricted and not has_alert and has_cd12
            and email is not null and s00_avail >= 5000$w$),
 'aokafor', 'Review step shows a confirmation dialog listing the existing certificate.', 150),

('many_accounts', 'Large relationship',
 'Member with the most open sub-accounts — long account list and history.',
 (select member_number from seed.cand where status = 'active' and not is_restricted order by open_accts desc, member_number limit 1),
 'aokafor', 'Accounts tab lists deposits, certificates, and loans with totals.', 160);

select key, member_number, sign_in_as from core.test_scenarios order by sort_order;
