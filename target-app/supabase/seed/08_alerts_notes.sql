-- Member alerts derived from record state, plus interaction notes.
select setseed(0.71);

insert into core.member_alerts (member_id, alert_type, severity, message, created_at, created_by_name)
select m.id, 'deceased'::core.alert_type, 'critical'::core.alert_severity,
       'Member reported deceased on ' || to_char(m.deceased_on, 'FMMon DD, YYYY') || '. Accounts are frozen pending estate documentation.',
       (m.deceased_on + 3)::timestamp + interval '10 hours', 'Estate Services'
from core.members m where m.status = 'deceased'
union all
select m.id, 'id_expired'::core.alert_type, 'warning'::core.alert_severity,
       m.id_document_type || ' on file expired ' || to_char(m.id_document_expires_on, 'FMMon DD, YYYY') || '. Ask for a current government ID at the next visit.',
       m.id_document_expires_on::timestamp + interval '6 hours', 'System'
from core.members m where m.id_document_expires_on < date '2026-09-22' and m.status in ('active', 'dormant')
union all
select m.id, 'legal_hold'::core.alert_type, 'critical'::core.alert_severity,
       'Legal hold: subpoena on file. Do not disclose account information; refer all inquiries to the Legal department.',
       now() - (floor(random() * 200)::int * interval '1 day'), 'Legal Department'
from core.members m where m.restriction_reason = 'Legal hold'
union all
select m.id, 'fraud_alert'::core.alert_type, 'critical'::core.alert_severity,
       'Open fraud investigation. Verify identity with two forms of ID and do not change contact details without Fraud Services approval.',
       now() - (floor(random() * 120)::int * interval '1 day'), 'Fraud Services'
from core.members m where m.restriction_reason = 'Fraud investigation';

with pool as (
  select m.id, random() as r
  from core.members m
  where m.status in ('active', 'dormant') and not m.is_restricted
)
insert into core.member_alerts (member_id, alert_type, severity, message, created_at, created_by_name)
select p.id,
       x.alert_type::core.alert_type,
       x.severity::core.alert_severity,
       x.message,
       now() - (floor(random() * x.max_age_days)::int * interval '1 day'),
       x.author
from pool p
join (values
  (0.000, 0.002, 'ofac_review', 'critical', 'Potential OFAC SDN list match on name. Compliance review is open; do not open accounts or send wires until it is cleared.', 45, 'BSA/AML Compliance'),
  (0.002, 0.007, 'fraud_alert', 'warning', 'Card compromise reported. Verify identity with two forms of ID before changing contact details or ordering cards.', 90, 'Fraud Services'),
  (0.007, 0.019, 'address_undeliverable', 'warning', 'Mail returned as undeliverable. Confirm the member''s current mailing address.', 300, 'Mail Services'),
  (0.019, 0.022, 'bankruptcy', 'warning', 'Chapter 7 bankruptcy notice received. Refer collection questions to the Collections department.', 400, 'Collections'),
  (0.022, 0.028, 'do_not_contact', 'info', 'Member opted out of marketing calls, texts, and emails.', 900, 'Member Services')
) as x(lo, hi, alert_type, severity, message, max_age_days, author)
  on p.r >= x.lo and p.r < x.hi;

-- interaction notes ----------------------------------------------------------------------------------
with templates(category, body) as (values
  ('Service', 'Member called asking about current certificate rates. Quoted 12-month at 4.25% APY and 24-month at 3.90% APY. Member will decide after talking with spouse.'),
  ('Service', 'Walked member through online banking enrollment and two-step verification setup. Member signed in successfully before ending the call.'),
  ('Service', 'Member requested a replacement debit card because the chip is worn. Ordered; arrives in 7–10 business days.'),
  ('Service', 'Member asked when the Holiday Club pays out. Explained the balance moves to S00 on November 1.'),
  ('Service', 'Mailed statement copies for the last three months at member''s request.'),
  ('Service', 'Member asked how to set up direct deposit with a new employer. Printed a direct deposit letter with routing and account numbers.'),
  ('Service', 'Reset online banking password after verifying identity with security questions and a one-time code.'),
  ('Service', 'Member asked about auto loan pre-approval. Referred to Consumer Lending; appointment booked for next week.'),
  ('Service', 'Member dropped off updated beneficiary forms. Sent to Operations for processing.'),
  ('Service', 'Member asked about Reg D transfer limits on money market. Explained six-withdrawal limit per statement cycle.'),
  ('Account maintenance', 'Updated mailing address per member request. Verified identity with driver license.'),
  ('Account maintenance', 'Updated mobile phone number and sent a confirmation text to the new number.'),
  ('Account maintenance', 'Switched statements to electronic delivery at member''s request.'),
  ('Account maintenance', 'Added overdraft protection transfer from S00 to checking.'),
  ('Account maintenance', 'Stopped automatic Holiday Club transfer effective next cycle, per member request.'),
  ('Account maintenance', 'Updated employer and occupation. Member started a new position this month.'),
  ('Fraud', 'Member reported unrecognized card transactions. Card blocked, dispute opened for three transactions, replacement card ordered.'),
  ('Fraud', 'Member received a text claiming to be RFCU asking for a login code. Advised we never ask for codes by text. No account impact.'),
  ('Fraud', 'Deposited check returned as counterfeit. Member advised; hold placed per funds availability policy.'),
  ('Collections', 'Called member about auto loan payment 15 days past due. Member will pay Friday through online banking.'),
  ('Collections', 'Member asked to move the Visa due date. Changed due date to the 15th starting next cycle.'),
  ('Collections', 'Discussed hardship options after member reported reduced hours. Sent skip-a-payment application.'),
  ('Complaint', 'Member unhappy about a non-network ATM fee. Explained fee schedule and refunded one fee as a courtesy.'),
  ('Complaint', 'Member complained about Saturday wait times at the branch. Apologized and forwarded feedback to the branch manager.'),
  ('Complaint', 'Member disputed Premier Checking monthly fee. Balance fell below $2,500 on the 12th, so the fee was correct. Explained waiver requirements.'),
  ('Compliance', 'CIP re-verification completed. Scanned current driver license into imaging.'),
  ('Compliance', 'Cash deposit over $10,000. Currency Transaction Report filed per BSA requirements.'),
  ('Compliance', 'Member asked about sending an international wire. Explained documentation requirements and OFAC screening at initiation.')
),
t as (select row_number() over () as n, category, body from templates),
staff as (
  select array_agg(id order by username) as ids, array_agg(full_name order by username) as names, count(*)::int as n
  from core.staff
),
-- draw every random index exactly once per note (random() in a join
-- condition would be re-evaluated for each candidate row)
x as materialized (
  select m.id as member_id, m.member_since,
         1 + floor(random() * (select n from staff))::int as ai,
         1 + floor(random() * 28)::int as ti,
         random() as rp, random() as rt
  from core.members m
  cross join lateral generate_series(1, 1 + floor(random() * 3)::int + 0 * m.id::int) k
  where m.id % 100 < 28
)
insert into core.member_notes (member_id, author_id, author_name, category, body, is_pinned, created_at)
select x.member_id, s.ids[x.ai], s.names[x.ai], t.category, t.body,
       t.category in ('Fraud', 'Compliance') and x.rp < 0.25,
       greatest(x.member_since::timestamp, now() - (power(x.rt, 1.8) * interval '1095 days'))
from x
cross join staff s
join t on t.n = x.ti;
