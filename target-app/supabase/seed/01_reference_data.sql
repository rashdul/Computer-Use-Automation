-- Reference data: branches, permission catalogue, role grants, products.
-- Idempotent — safe to re-run.

insert into core.branches (id, code, name, address_line1, city, state, postal_code, phone, opened_on) values
  (1, 'BAL', 'Baltimore Main Office',   '210 N Calvert St',            'Baltimore',     'MD', '21202', '4105550100', '1962-05-01'),
  (2, 'TWS', 'Towson',                  '415 York Rd',                 'Towson',        'MD', '21204', '4105550118', '1978-09-12'),
  (3, 'COL', 'Columbia',                '10280 Little Patuxent Pkwy',  'Columbia',      'MD', '21044', '4105550131', '1989-03-06'),
  (4, 'ANP', 'Annapolis',               '128 West St',                 'Annapolis',     'MD', '21401', '4105550142', '1994-06-20'),
  (5, 'SSP', 'Silver Spring',           '8605 Georgia Ave',            'Silver Spring', 'MD', '20910', '3015550156', '2001-10-01'),
  (6, 'DCK', 'Washington K Street',     '1725 K St NW',                'Washington',    'DC', '20006', '2025550167', '2008-04-14'),
  (7, 'ARL', 'Arlington',               '3100 Clarendon Blvd',         'Arlington',     'VA', '22201', '7035550173', '2013-08-05'),
  (8, 'GLB', 'Glen Burnie',             '7640 Ritchie Hwy',            'Glen Burnie',   'MD', '21061', '4105550189', '2017-02-27')
on conflict (id) do update set
  code = excluded.code, name = excluded.name, address_line1 = excluded.address_line1, city = excluded.city,
  state = excluded.state, postal_code = excluded.postal_code, phone = excluded.phone, opened_on = excluded.opened_on;

insert into core.permissions (code, label, description, category, sort_order) values
  ('members.search',          'Search members',             'Find members by name, member number, SSN (last 4 or full), phone, or email.', 'Members', 10),
  ('members.view',            'View member profiles',       'Open member records, contact details, relationships, and alerts.', 'Members', 20),
  ('members.view_sensitive',  'Reveal full SSN',            'Unmask a member''s full Social Security number. Every reveal is logged.', 'Members', 30),
  ('members.view_restricted', 'Open restricted records',    'Open employee, insider (Reg O), legal-hold, and fraud-investigation records.', 'Members', 40),
  ('notes.create',            'Add member notes',           'Record service interactions on a member''s profile.', 'Members', 50),
  ('accounts.view',           'View accounts and balances', 'See sub-accounts, balances, rates, owners, and beneficiaries.', 'Accounts', 60),
  ('transactions.view',       'View transaction history',   'See posted and pending transactions on any sub-account.', 'Accounts', 70),
  ('accounts.open',           'Open sub-accounts',          'Open share, checking, money market, club, certificate, and IRA sub-accounts.', 'Accounts', 80),
  ('audit.view',              'View access logs',           'See who opened a member''s record and what they did.', 'Oversight', 90),
  ('admin.console',           'Use Administration',         'Manage staff access, roles, environment controls, and products.', 'Oversight', 100)
on conflict (code) do update set
  label = excluded.label, description = excluded.description, category = excluded.category, sort_order = excluded.sort_order;

insert into core.role_permissions (role, permission_code)
select r.role::core.staff_role, r.permission_code
from (values
  ('teller', 'members.search'), ('teller', 'members.view'), ('teller', 'notes.create'),
  ('teller', 'accounts.view'), ('teller', 'transactions.view'),

  ('member_service_rep', 'members.search'), ('member_service_rep', 'members.view'),
  ('member_service_rep', 'members.view_sensitive'), ('member_service_rep', 'notes.create'),
  ('member_service_rep', 'accounts.view'), ('member_service_rep', 'transactions.view'),
  ('member_service_rep', 'accounts.open'),

  ('branch_manager', 'members.search'), ('branch_manager', 'members.view'),
  ('branch_manager', 'members.view_sensitive'), ('branch_manager', 'members.view_restricted'),
  ('branch_manager', 'notes.create'), ('branch_manager', 'accounts.view'),
  ('branch_manager', 'transactions.view'), ('branch_manager', 'accounts.open'),
  ('branch_manager', 'audit.view'),

  ('compliance_officer', 'members.search'), ('compliance_officer', 'members.view'),
  ('compliance_officer', 'members.view_sensitive'), ('compliance_officer', 'members.view_restricted'),
  ('compliance_officer', 'notes.create'), ('compliance_officer', 'accounts.view'),
  ('compliance_officer', 'transactions.view'), ('compliance_officer', 'audit.view'),

  -- segregation of duties: administrators manage access, they don't transact
  ('system_admin', 'members.search'), ('system_admin', 'members.view'),
  ('system_admin', 'accounts.view'), ('system_admin', 'transactions.view'),
  ('system_admin', 'audit.view'), ('system_admin', 'admin.console')
) as r(role, permission_code)
on conflict do nothing;

insert into core.products (code, name, category, suffix_prefix, suffix_min, suffix_max, description,
                           min_opening_deposit, min_balance, rate, term_months, max_per_member, min_age, max_age,
                           monthly_fee, is_openable, is_active, disclosure_code, sort_order) values
  ('SHR-MEM',  'Membership Share',            'share',        'S', 0, 0,   'Establishes membership. The $5.00 par value stays on deposit for the life of the membership.', 5, 5, 0.100, null, 1, null, null, 0, false, true, null, 10),
  ('SHR-REG',  'Regular Share Savings',       'share',        'S', 1, 9,   'Everyday savings with dividends paid monthly.', 0, 0, 0.150, null, 3, null, null, 0, true, true, null, 20),
  ('SHR-YTH',  'Youth Savings',               'share',        'S', 10, 14, 'Savings for members under 18. Pays a bonus rate on balances up to $1,000.', 0, 0, 1.500, null, 1, null, 17, 0, true, true, null, 30),
  ('CLB-HOL',  'Holiday Club',                'club',         'S', 20, 24, 'Save through the year; the balance transfers to S00 every November 1.', 0, 0, 0.500, null, 1, null, null, 0, true, true, null, 40),
  ('CLB-VAC',  'Vacation Club',               'club',         'S', 25, 29, 'Save for travel; the balance transfers to S00 every May 1.', 0, 0, 0.500, null, 1, null, null, 0, true, true, null, 50),
  ('DFT-BAS',  'Basic Checking',              'share_draft',  'D', 1, 9,   'No monthly fee. Includes a Visa debit card and online bill pay.', 25, 0, 0.000, null, 2, 16, null, 0, true, true, 'DFT-2026-02', 60),
  ('DFT-PRM',  'Premier Checking',            'share_draft',  'D', 1, 9,   'Dividend-earning checking. The $6.00 monthly fee is waived with a $2,500 average daily balance.', 100, 0, 0.250, null, 2, 18, null, 6, true, true, 'DFT-2026-02', 70),
  ('MMA-PLT',  'Platinum Money Market',       'money_market', 'M', 1, 9,   'Tiered dividends on balances of $2,500 or more. Six withdrawals per statement cycle.', 2500, 2500, 3.150, null, 1, 18, null, 0, true, true, null, 80),
  ('CD-06',    '6-Month Share Certificate',   'certificate',  'C', 1, 99,  'Fixed rate for 6 months. Early withdrawal penalty: 90 days of dividends.', 500, 500, 4.050, 6, null, 18, null, 0, true, true, 'TIS-CERT-2026-03', 90),
  ('CD-12',    '12-Month Share Certificate',  'certificate',  'C', 1, 99,  'Fixed rate for 12 months. Early withdrawal penalty: 180 days of dividends.', 500, 500, 4.250, 12, null, 18, null, 0, true, true, 'TIS-CERT-2026-03', 100),
  ('CD-18',    '18-Month Share Certificate',  'certificate',  'C', 1, 99,  'Fixed rate for 18 months. Early withdrawal penalty: 180 days of dividends.', 1000, 1000, 4.000, 18, null, 18, null, 0, true, false, 'TIS-CERT-2026-03', 110),
  ('CD-24',    '24-Month Share Certificate',  'certificate',  'C', 1, 99,  'Fixed rate for 24 months. Early withdrawal penalty: 365 days of dividends.', 1000, 1000, 3.900, 24, null, 18, null, 0, true, true, 'TIS-CERT-2026-03', 120),
  ('CD-36',    '36-Month Share Certificate',  'certificate',  'C', 1, 99,  'Fixed rate for 36 months. Early withdrawal penalty: 365 days of dividends.', 1000, 1000, 3.750, 36, null, 18, null, 0, true, true, 'TIS-CERT-2026-03', 130),
  ('CD-60',    '60-Month Share Certificate',  'certificate',  'C', 1, 99,  'Fixed rate for 60 months. Early withdrawal penalty: 365 days of dividends.', 1000, 1000, 3.650, 60, null, 18, null, 0, true, true, 'TIS-CERT-2026-03', 140),
  ('IRA-TRD',  'Traditional IRA Share',       'ira',          'I', 1, 9,   'Tax-deferred retirement savings. Contributions may be tax-deductible.', 25, 0, 2.750, null, 1, 18, null, 0, true, true, 'IRA-DISC-2025-11', 150),
  ('IRA-ROTH', 'Roth IRA Share',              'ira',          'I', 1, 9,   'After-tax contributions; qualified withdrawals are tax-free.', 25, 0, 2.750, null, 1, 18, null, 0, true, true, 'IRA-DISC-2025-11', 160),
  ('LN-AUTO',  'Auto Loan',                   'loan',         'L', 1, 99,  'New and used vehicle financing.', 0, 0, 5.990, null, null, 18, null, 0, false, true, null, 170),
  ('LN-SIG',   'Signature Loan',              'loan',         'L', 1, 99,  'Unsecured personal loan.', 0, 0, 10.490, null, null, 18, null, 0, false, true, null, 180),
  ('LN-VISA',  'Visa Platinum Credit Card',   'loan',         'L', 1, 99,  'Credit card with no annual fee.', 0, 0, 15.900, null, null, 18, null, 0, false, true, null, 190),
  ('LN-HELOC', 'Home Equity Line of Credit',  'loan',         'L', 1, 99,  'Variable-rate line secured by home equity.', 0, 0, 7.250, null, null, 18, null, 0, false, true, null, 200),
  ('LN-MORT',  '30-Year Fixed Mortgage',      'loan',         'L', 1, 99,  'First mortgage, 30-year fixed rate.', 0, 0, 6.375, null, null, 18, null, 0, false, true, null, 210)
on conflict (code) do update set
  name = excluded.name, category = excluded.category, suffix_prefix = excluded.suffix_prefix,
  suffix_min = excluded.suffix_min, suffix_max = excluded.suffix_max, description = excluded.description,
  min_opening_deposit = excluded.min_opening_deposit, min_balance = excluded.min_balance, rate = excluded.rate,
  term_months = excluded.term_months, max_per_member = excluded.max_per_member, min_age = excluded.min_age,
  max_age = excluded.max_age, monthly_fee = excluded.monthly_fee, is_openable = excluded.is_openable,
  is_active = excluded.is_active, disclosure_code = excluded.disclosure_code, sort_order = excluded.sort_order;
