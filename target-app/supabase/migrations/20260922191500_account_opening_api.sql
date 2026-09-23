-- =====================================================================
-- Migration 4 — sub-account opening (private SECURITY DEFINER)
-- =====================================================================

-- Everything the Open Sub-Account form needs in one round trip.
create or replace function private.get_open_account_context(p_member_number text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb;
  v_m core.members;
  v_today date := private.today();
begin
  -- permission first, so a denied user learns nothing about the member
  v_err := private.check_permission(v_staff, 'accounts.open', null, 'Open a sub-account');
  if v_err is not null then
    return v_err;
  end if;
  v_err := private.member_access_error(v_staff, p_member_number, 'account.open_start');
  if v_err is not null then
    return v_err;
  end if;
  select * into v_m from core.members where member_number = p_member_number;

  return jsonb_build_object(
    'member', jsonb_build_object(
      'member_number', v_m.member_number,
      'display_name', private.display_name(v_m.first_name, v_m.middle_name, v_m.last_name, v_m.name_suffix),
      'full_name', private.full_name(v_m.first_name, v_m.middle_name, v_m.last_name, v_m.name_suffix),
      'age', private.age_on(v_m.date_of_birth, v_today),
      'status', v_m.status,
      'membership_type', v_m.membership_type,
      'kyc_status', v_m.kyc_status,
      'has_email', v_m.email is not null,
      'email_masked', case when v_m.email is null then null
                           else left(v_m.email, 1) || '•••••' || substr(v_m.email, position('@' in v_m.email)) end,
      'mailing_address', v_m.address_line1 || coalesce(', ' || v_m.address_line2, '') || ', ' || v_m.city || ', ' || v_m.state || ' ' || v_m.postal_code
    ),
    'blockers', private.opening_blockers(v_m),
    'screening', jsonb_build_object(
      'ofac', case when exists (select 1 from core.member_alerts al where al.member_id = v_m.id and al.alert_type = 'ofac_review' and al.resolved_at is null)
                   then 'review_required' else 'clear' end,
      'cip', v_m.kyc_status,
      'screened_at', now()
    ),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', p.code, 'name', p.name, 'category', p.category, 'description', p.description,
        'min_opening_deposit', p.min_opening_deposit, 'min_balance', p.min_balance, 'rate', p.rate,
        'term_months', p.term_months, 'monthly_fee', p.monthly_fee, 'max_per_member', p.max_per_member,
        'disclosures', to_jsonb(private.required_disclosures(p)),
        'eligibility', private.product_eligibility(v_m, p)
      ) order by p.sort_order)
      from core.products p
      where p.is_openable and p.is_active
    ), '[]'::jsonb),
    'funding_accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'account_number', owner.member_number || '-' || a.suffix,
        'suffix', a.suffix,
        'product_name', p.name,
        'category', p.category,
        'nickname', a.nickname,
        'ownership', ids.ownership,
        'available_balance', a.available_balance,
        'min_balance', p.min_balance,
        'transferable', greatest(a.available_balance - p.min_balance, 0)
      ) order by p.category, a.suffix)
      from private.member_account_ids(v_m.id) ids
      join core.accounts a on a.id = ids.account_id
      join core.products p on p.code = a.product_code
      join core.members owner on owner.id = a.member_id
      where a.status = 'open' and p.category in ('share', 'share_draft', 'money_market')
    ), '[]'::jsonb),
    'joint_candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'member_number', rm.member_number,
        'display_name', private.display_name(rm.first_name, rm.middle_name, rm.last_name, rm.name_suffix),
        'relationship', r.relationship,
        'eligible', x.reason is null,
        'reason', x.reason
      ) order by x.reason is not null, rm.last_name, rm.first_name)
      from core.member_relationships r
      join core.members rm on rm.id = r.related_member_id
      cross join lateral (
        select case
          when rm.is_restricted then 'Restricted record'
          when rm.status <> 'active' then 'Membership is ' || rm.status
          when rm.kyc_status <> 'verified' then 'Identity verification not current'
          when private.age_on(rm.date_of_birth, v_today) < 18 then 'Must be 18 or older'
        end as reason
      ) x
      where r.member_id = v_m.id
    ), '[]'::jsonb),
    'disclosure_catalog', jsonb_build_array(
      jsonb_build_object('code', 'TIS-2026-03', 'title', 'Truth in Savings disclosure', 'revised', '2026-03'),
      jsonb_build_object('code', 'FEE-2026-01', 'title', 'Schedule of fees and charges', 'revised', '2026-01'),
      jsonb_build_object('code', 'PRIV-2025-10', 'title', 'Privacy notice', 'revised', '2025-10'),
      jsonb_build_object('code', 'TIS-CERT-2026-03', 'title', 'Share certificate terms addendum', 'revised', '2026-03'),
      jsonb_build_object('code', 'IRA-DISC-2025-11', 'title', 'IRA disclosure statement and custodial agreement', 'revised', '2025-11'),
      jsonb_build_object('code', 'DFT-2026-02', 'title', 'Share draft (checking) account agreement', 'revised', '2026-02')
    )
  );
end
$$;

-- Verifies a prospective joint owner typed in by member number.
create or replace function private.lookup_member_brief(p_member_number text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb;
  v_m core.members;
  v_reason text;
begin
  v_err := private.check_permission(v_staff, 'accounts.open', null, 'Look up joint owner');
  if v_err is not null then
    return v_err;
  end if;
  if p_member_number is null or p_member_number !~ '^[0-9]{7}$' then
    return private.invalid(jsonb_build_array(private.field_error('member_number', 'Enter a 7-digit member number.')));
  end if;

  select * into v_m from core.members where member_number = p_member_number;
  if not found then
    return private.fail(404, 'RF404', 'member_not_found', jsonb_build_object('member_number', p_member_number));
  end if;

  if v_m.is_restricted and not private.has_permission(v_staff.role, 'members.view_restricted') then
    return jsonb_build_object('member_number', v_m.member_number, 'display_name', 'Restricted record',
      'eligible', false, 'reason', 'Restricted record');
  end if;

  v_reason := case
    when v_m.is_restricted then 'Restricted record'
    when v_m.status <> 'active' then 'Membership is ' || v_m.status
    when v_m.kyc_status <> 'verified' then 'Identity verification not current'
    when private.age_on(v_m.date_of_birth, private.today()) < 18 then 'Must be 18 or older'
  end;

  return jsonb_build_object(
    'member_number', v_m.member_number,
    'display_name', private.display_name(v_m.first_name, v_m.middle_name, v_m.last_name, v_m.name_suffix),
    'status', v_m.status,
    'eligible', v_reason is null,
    'reason', v_reason
  );
end
$$;

-- Opens a sub-account. Every rule is re-validated here — the form's checks
-- are a courtesy. Idempotent on client_request_id: resubmitting the same
-- request returns the original receipt instead of opening a second account.
create or replace function private.open_sub_account(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb;
  v_req_id uuid;
  v_existing_conf text;
  v_m core.members;
  v_p core.products;
  v_elig jsonb;
  v_fields jsonb := '[]'::jsonb;
  v_blockers jsonb;
  v_today date := private.today();
  v_nickname text := nullif(btrim(coalesce(p_request ->> 'nickname', '')), '');
  v_ownership text := coalesce(p_request #>> '{ownership,type}', 'individual');
  v_joint_numbers text[];
  v_joint core.members;
  v_joint_ids bigint[] := '{}';
  v_joint_names text[] := '{}';
  v_bens jsonb := coalesce(p_request -> 'beneficiaries', '[]'::jsonb);
  v_ben jsonb;
  v_ben_total numeric := 0;
  v_ben_pct numeric;
  v_i integer;
  v_method text := coalesce(p_request #>> '{funding,method}', '');
  v_amount numeric := private.try_numeric(p_request #>> '{funding,amount}');
  v_src_number text := nullif(p_request #>> '{funding,source_account_number}', '');
  v_src_id bigint;
  v_src core.accounts;
  v_src_p core.products;
  v_check_no text := nullif(btrim(coalesce(p_request #>> '{funding,check_number}', '')), '');
  v_maturity text := p_request #>> '{certificate,maturity_option}';
  v_dividend text := p_request #>> '{certificate,dividend_disposition}';
  v_od_number text := nullif(p_request #>> '{checking,overdraft_source_account_number}', '');
  v_od_id bigint;
  v_debit_card boolean := coalesce((p_request #>> '{checking,order_debit_card}')::boolean, false);
  v_statement text := coalesce(p_request ->> 'statement_delivery', '');
  v_purpose text := nullif(btrim(coalesce(p_request #>> '{compliance,purpose}', '')), '');
  v_expected text := p_request #>> '{compliance,expected_monthly_deposits}';
  v_source_funds text := p_request #>> '{compliance,source_of_funds}';
  v_ack text[] := array(select jsonb_array_elements_text(coalesce(p_request -> 'disclosures_acknowledged', '[]'::jsonb)));
  v_missing text[];
  v_signature text := coalesce(p_request ->> 'signature_method', '');
  v_confirm_dup boolean := coalesce((p_request ->> 'confirm_duplicate_product')::boolean, false);
  v_suffix text;
  v_account_number text;
  v_hold numeric := 0;
  v_acc_id bigint;
  v_conf text;
  v_src_account_number text;
begin
  v_err := private.check_permission(v_staff, 'accounts.open', null, 'Open a sub-account');
  if v_err is not null then
    return v_err;
  end if;

  begin
    v_req_id := (p_request ->> 'client_request_id')::uuid;
  exception when others then
    v_req_id := null;
  end;
  if v_req_id is null then
    return private.invalid(jsonb_build_array(private.field_error('client_request_id', 'Request ID is missing. Reload the review page and try again.')));
  end if;

  select o.confirmation_number into v_existing_conf from core.account_openings o where o.client_request_id = v_req_id;
  if v_existing_conf is not null then
    return private.opening_receipt(v_existing_conf) || jsonb_build_object('idempotent_replay', true);
  end if;

  v_err := private.member_access_error(v_staff, p_request ->> 'member_number', 'account.open');
  if v_err is not null then
    return v_err;
  end if;
  select * into v_m from core.members where member_number = p_request ->> 'member_number';

  -- one opening at a time per member (suffix allocation, funding balance)
  perform pg_advisory_xact_lock(7201, v_m.id::integer);

  v_blockers := private.opening_blockers(v_m);
  if jsonb_array_length(v_blockers) > 0 then
    perform private.audit(v_staff, 'account.open', 'failed', v_m.id, null,
      'Account opening blocked for ' || v_m.member_number, jsonb_build_object('blockers', v_blockers));
    return private.fail(409, 'RF409', 'member_ineligible', jsonb_build_object('issues', v_blockers));
  end if;

  -- product ---------------------------------------------------------------
  select * into v_p from core.products where code = p_request ->> 'product_code';
  if v_p.code is null or not v_p.is_openable then
    v_fields := v_fields || private.field_error('product_code', 'Choose a product.');
  else
    v_elig := private.product_eligibility(v_m, v_p);
    if not (v_elig ->> 'eligible')::boolean then
      v_fields := v_fields || private.field_error('product_code', v_p.name || ': ' || (v_elig ->> 'reason') || '.');
    end if;
  end if;

  if v_nickname is not null and (length(v_nickname) > 30 or v_nickname !~ '^[A-Za-z0-9 ''&.,()-]+$') then
    v_fields := v_fields || private.field_error('nickname', 'Use up to 30 letters, numbers, spaces, and basic punctuation.');
  end if;

  -- ownership ---------------------------------------------------------------
  if v_ownership not in ('individual', 'joint') then
    v_fields := v_fields || private.field_error('ownership.type', 'Choose individual or joint ownership.');
  elsif v_ownership = 'joint' then
    v_joint_numbers := array(select distinct x from jsonb_array_elements_text(coalesce(p_request #> '{ownership,joint_member_numbers}', '[]'::jsonb)) x);
    if coalesce(array_length(v_joint_numbers, 1), 0) = 0 then
      v_fields := v_fields || private.field_error('ownership.joint_member_numbers', 'Add at least one joint owner.');
    elsif array_length(v_joint_numbers, 1) > 3 then
      v_fields := v_fields || private.field_error('ownership.joint_member_numbers', 'A sub-account can have at most 3 joint owners.');
    else
      for v_i in 1 .. array_length(v_joint_numbers, 1) loop
        select * into v_joint from core.members where member_number = v_joint_numbers[v_i];
        if v_joint.id is null then
          v_fields := v_fields || private.field_error('ownership.joint_member_numbers', 'No member record ' || v_joint_numbers[v_i] || '.');
        elsif v_joint.id = v_m.id then
          v_fields := v_fields || private.field_error('ownership.joint_member_numbers', 'The primary member can''t also be a joint owner.');
        elsif v_joint.is_restricted or v_joint.status <> 'active' or v_joint.kyc_status <> 'verified'
              or private.age_on(v_joint.date_of_birth, v_today) < 18 then
          v_fields := v_fields || private.field_error('ownership.joint_member_numbers',
            v_joint_numbers[v_i] || ' can''t be a joint owner: ' ||
            case
              when v_joint.is_restricted then 'restricted record'
              when v_joint.status <> 'active' then 'membership is ' || v_joint.status
              when v_joint.kyc_status <> 'verified' then 'identity verification not current'
              else 'must be 18 or older'
            end || '.');
        else
          v_joint_ids := v_joint_ids || v_joint.id;
          v_joint_names := v_joint_names || private.full_name(v_joint.first_name, v_joint.middle_name, v_joint.last_name, v_joint.name_suffix);
        end if;
        v_joint := null;
      end loop;
    end if;
  end if;

  -- beneficiaries (payable on death) -------------------------------------------
  if jsonb_typeof(v_bens) <> 'array' then
    v_fields := v_fields || private.field_error('beneficiaries', 'Beneficiaries are malformed.');
  elsif jsonb_array_length(v_bens) > 4 then
    v_fields := v_fields || private.field_error('beneficiaries', 'Add up to 4 beneficiaries.');
  elsif jsonb_array_length(v_bens) > 0 then
    for v_i in 0 .. jsonb_array_length(v_bens) - 1 loop
      v_ben := v_bens -> v_i;
      v_ben_pct := private.try_numeric(v_ben ->> 'percent');
      if length(btrim(coalesce(v_ben ->> 'name', ''))) < 2 then
        v_fields := v_fields || private.field_error('beneficiaries.' || v_i || '.name', 'Enter the beneficiary''s full name.');
      end if;
      if nullif(btrim(coalesce(v_ben ->> 'relationship', '')), '') is null then
        v_fields := v_fields || private.field_error('beneficiaries.' || v_i || '.relationship', 'Choose a relationship.');
      end if;
      if v_ben_pct is null or v_ben_pct <= 0 or v_ben_pct > 100 or v_ben_pct <> round(v_ben_pct, 2) then
        v_fields := v_fields || private.field_error('beneficiaries.' || v_i || '.percent', 'Enter a share between 0.01 and 100.');
      else
        v_ben_total := v_ben_total + v_ben_pct;
      end if;
    end loop;
    if v_ben_total <> 100 and not exists (
      select 1 from jsonb_array_elements(v_fields) f where f ->> 'field' like 'beneficiaries.%.percent'
    ) then
      v_fields := v_fields || private.field_error('beneficiaries', 'Beneficiary shares must add up to 100%. They add up to ' || trim(to_char(v_ben_total, 'FM990.00')) || '%.');
    end if;
  end if;

  -- funding ---------------------------------------------------------------------
  if v_method not in ('transfer', 'cash', 'check', 'none') then
    v_fields := v_fields || private.field_error('funding.method', 'Choose how the account will be funded.');
  elsif v_method = 'none' then
    v_amount := 0;
    if v_p.code is not null and v_p.min_opening_deposit > 0 then
      v_fields := v_fields || private.field_error('funding.method',
        v_p.name || ' needs an opening deposit of at least ' || to_char(v_p.min_opening_deposit, 'FM$999,999,990.00') || '.');
    end if;
  else
    if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
      v_fields := v_fields || private.field_error('funding.amount', 'Enter a dollar amount, like 250.00.');
    elsif v_amount > 1000000 then
      v_fields := v_fields || private.field_error('funding.amount', 'Opening deposits over $1,000,000.00 need treasury approval.');
    elsif v_p.code is not null and v_amount < v_p.min_opening_deposit then
      v_fields := v_fields || private.field_error('funding.amount',
        'Minimum opening deposit for ' || v_p.name || ' is ' || to_char(v_p.min_opening_deposit, 'FM$999,999,990.00') || '.');
    end if;

    if v_method = 'transfer' then
      if v_src_number is null then
        v_fields := v_fields || private.field_error('funding.source_account_number', 'Choose the account to transfer from.');
      else
        v_src_id := private.resolve_account(v_m.id, v_src_number);
        select * into v_src from core.accounts where id = v_src_id;
        select * into v_src_p from core.products where code = v_src.product_code;
        if v_src.id is null then
          v_fields := v_fields || private.field_error('funding.source_account_number', 'That account isn''t on this membership.');
        elsif v_src.status <> 'open' or v_src_p.category not in ('share', 'share_draft', 'money_market') then
          v_fields := v_fields || private.field_error('funding.source_account_number', 'Transfers can only come from an open share, checking, or money market account.');
        elsif v_amount is not null and v_amount > 0 and v_src.available_balance - v_amount < v_src_p.min_balance then
          v_fields := v_fields || private.field_error('funding.amount',
            case when v_src.available_balance < v_amount
              then 'Available balance in ' || upper(v_src_number) || ' is ' || to_char(v_src.available_balance, 'FM$999,999,990.00') || '.'
              else upper(v_src_number) || ' must keep its ' || to_char(v_src_p.min_balance, 'FM$999,999,990.00') || ' minimum balance. You can transfer up to '
                   || to_char(greatest(v_src.available_balance - v_src_p.min_balance, 0), 'FM$999,999,990.00') || '.'
            end);
        end if;
      end if;
    elsif v_method = 'cash' and v_amount is not null and v_amount > 10000 then
      v_fields := v_fields || private.field_error('funding.amount', 'Cash over $10,000.00 needs a Currency Transaction Report. Accept it at a teller station instead.');
    elsif v_method = 'check' and (v_check_no is null or v_check_no !~ '^[0-9]{3,10}$') then
      v_fields := v_fields || private.field_error('funding.check_number', 'Enter the 3–10 digit check number.');
    end if;
  end if;

  -- product-specific ------------------------------------------------------------
  if v_p.category = 'certificate' then
    if v_maturity is null or v_maturity not in ('renew', 'transfer_to_share', 'mail_check') then
      v_fields := v_fields || private.field_error('certificate.maturity_option', 'Choose what happens at maturity.');
    end if;
    if v_dividend is null or v_dividend not in ('compound', 'transfer_to_share') then
      v_fields := v_fields || private.field_error('certificate.dividend_disposition', 'Choose how dividends are paid.');
    end if;
  else
    v_maturity := null;
    v_dividend := null;
  end if;

  if v_p.category = 'share_draft' then
    if v_od_number is not null then
      v_od_id := private.resolve_account(v_m.id, v_od_number);
      if v_od_id is null or not exists (
        select 1 from core.accounts a join core.products p on p.code = a.product_code
        where a.id = v_od_id and a.status = 'open' and p.category in ('share', 'money_market')
      ) then
        v_fields := v_fields || private.field_error('checking.overdraft_source_account_number', 'Overdraft protection must come from an open share or money market account on this membership.');
      end if;
    end if;
  else
    v_od_id := null;
    v_debit_card := null;
  end if;

  -- statements, compliance, disclosures, signature -------------------------------
  if v_statement not in ('electronic', 'paper') then
    v_fields := v_fields || private.field_error('statement_delivery', 'Choose electronic or paper statements.');
  elsif v_statement = 'electronic' and v_m.email is null then
    v_fields := v_fields || private.field_error('statement_delivery', 'No email address on file. Choose paper statements or update the member''s email first.');
  end if;

  if v_purpose is null then
    v_fields := v_fields || private.field_error('compliance.purpose', 'Choose the purpose of the account.');
  end if;
  if v_expected is null or v_expected not in ('under_1000', '1000_5000', '5000_10000', 'over_10000') then
    v_fields := v_fields || private.field_error('compliance.expected_monthly_deposits', 'Choose the expected monthly deposits.');
  end if;
  if v_source_funds is null or v_source_funds not in ('employment', 'savings', 'retirement', 'gift_inheritance', 'business', 'other') then
    v_fields := v_fields || private.field_error('compliance.source_of_funds', 'Choose the source of funds.');
  end if;

  if v_p.code is not null then
    v_missing := array(select d from unnest(private.required_disclosures(v_p)) d where not d = any (v_ack));
    if coalesce(array_length(v_missing, 1), 0) > 0 then
      v_fields := v_fields || private.field_error('disclosures', 'Confirm the member received every required disclosure.');
    end if;
  end if;

  if v_signature not in ('signature_pad', 'wet_signature', 'e_sign') then
    v_fields := v_fields || private.field_error('signature_method', 'Record how the member signed.');
  end if;

  if jsonb_array_length(v_fields) > 0 then
    return private.invalid(v_fields);
  end if;

  -- duplicate product needs an explicit confirmation ---------------------------------
  if (v_elig ->> 'existing_count')::integer > 0 and not v_confirm_dup then
    return private.fail(409, 'RF409', 'duplicate_product', jsonb_build_object(
      'product_name', v_p.name,
      'existing', (
        select jsonb_agg(jsonb_build_object(
          'account_number', v_m.member_number || '-' || a.suffix,
          'nickname', a.nickname,
          'current_balance', a.current_balance,
          'opened_on', a.opened_on
        ) order by a.suffix)
        from core.accounts a
        where a.member_id = v_m.id and a.product_code = v_p.code and a.status <> 'closed'
      )
    ));
  end if;

  -- open it ------------------------------------------------------------------------
  v_suffix := v_elig ->> 'next_suffix';
  v_account_number := v_m.member_number || '-' || v_suffix;

  if v_method = 'transfer' then
    select * into v_src from core.accounts where id = v_src_id for update;
    if v_src.available_balance - v_amount < v_src_p.min_balance then
      return private.invalid(jsonb_build_array(private.field_error('funding.amount',
        'Available balance in ' || upper(v_src_number) || ' changed and no longer covers this transfer.')));
    end if;
    select om.member_number || '-' || v_src.suffix into v_src_account_number from core.members om where om.id = v_src.member_id;
  elsif v_method = 'check' then
    v_hold := greatest(v_amount - 225, 0);  -- Reg CC: first $225 available next business day
  end if;

  insert into core.accounts (
    member_id, suffix, product_code, nickname, status, opened_on,
    current_balance, available_balance, hold_amount, rate, term_months, maturity_date,
    maturity_option, dividend_disposition, statement_delivery, overdraft_source_account_id,
    debit_card_ordered, opened_by_id, opened_by_name, branch_id, last_activity_on
  )
  values (
    v_m.id, v_suffix, v_p.code, v_nickname, 'open', v_today,
    v_amount, v_amount - v_hold, v_hold, v_p.rate, v_p.term_months,
    case when v_p.term_months is null then null else (v_today + make_interval(months => v_p.term_months))::date end,
    v_maturity, v_dividend, v_statement, v_od_id,
    v_debit_card, v_staff.id, v_staff.full_name, v_staff.branch_id,
    case when v_amount > 0 then v_today end
  )
  returning id into v_acc_id;

  if array_length(v_joint_ids, 1) > 0 then
    insert into core.account_parties (account_id, member_id, party_name, role, relationship, added_on)
    select v_acc_id, j.id, j.name, 'joint', r.relationship, v_today
    from unnest(v_joint_ids, v_joint_names) as j(id, name)
    left join core.member_relationships r on r.member_id = v_m.id and r.related_member_id = j.id;
  end if;

  if jsonb_array_length(v_bens) > 0 then
    insert into core.account_parties (account_id, party_name, role, relationship, beneficiary_pct, added_on)
    select v_acc_id, btrim(b ->> 'name'), 'beneficiary', btrim(b ->> 'relationship'), (b ->> 'percent')::numeric, v_today
    from jsonb_array_elements(v_bens) b;
  end if;

  if v_amount > 0 then
    if v_method = 'transfer' then
      update core.accounts
         set current_balance = current_balance - v_amount,
             available_balance = available_balance - v_amount,
             last_activity_on = v_today
       where id = v_src.id;
      insert into core.transactions (account_id, posted_at, amount, balance_after, txn_type, channel, description, reference)
      values (v_src.id, now(), -v_amount, v_src.current_balance - v_amount, 'transfer_out', 'branch',
              'Transfer to ' || v_account_number || ' (new ' || v_p.name || ')', null);
      insert into core.transactions (account_id, posted_at, amount, balance_after, txn_type, channel, description, reference)
      values (v_acc_id, now(), v_amount, v_amount, 'transfer_in', 'branch',
              'Opening deposit · transfer from ' || v_src_account_number, null);
    elsif v_method = 'cash' then
      insert into core.transactions (account_id, posted_at, amount, balance_after, txn_type, channel, description)
      values (v_acc_id, now(), v_amount, v_amount, 'deposit', 'branch', 'Opening deposit · cash');
    else
      insert into core.transactions (account_id, posted_at, amount, balance_after, txn_type, channel, description, reference)
      values (v_acc_id, now(), v_amount, v_amount, 'check_deposit', 'branch', 'Opening deposit · check #' || v_check_no, v_check_no);
    end if;
  end if;

  loop
    v_conf := 'OA' || to_char(v_today, 'YYMMDD') || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
    exit when not exists (select 1 from core.account_openings where confirmation_number = v_conf);
  end loop;

  insert into core.account_openings (
    confirmation_number, client_request_id, member_id, account_id, product_code, initial_deposit,
    funding_method, funding_account_id, check_number, signature_method, disclosures, compliance,
    opened_by_id, branch_id
  )
  values (
    v_conf, v_req_id, v_m.id, v_acc_id, v_p.code, v_amount,
    v_method, case when v_method = 'transfer' then v_src.id end, case when v_method = 'check' then v_check_no end,
    v_signature, to_jsonb(v_ack),
    jsonb_build_object('purpose', v_purpose, 'expected_monthly_deposits', v_expected, 'source_of_funds', v_source_funds,
                       'ofac', 'clear', 'cip', v_m.kyc_status),
    v_staff.id, v_staff.branch_id
  );

  perform private.audit(v_staff, 'account.opened', 'success', v_m.id, v_acc_id,
    'Opened ' || v_account_number || ' · ' || v_p.name,
    jsonb_build_object('confirmation_number', v_conf, 'product_code', v_p.code, 'initial_deposit', v_amount,
                       'funding_method', v_method, 'ownership', v_ownership));

  perform set_config('response.status', '201', true);
  return private.opening_receipt(v_conf) || jsonb_build_object('idempotent_replay', false);
exception
  when unique_violation then
    -- a concurrent submit of the same request won the race; hand back its receipt
    select o.confirmation_number into v_existing_conf from core.account_openings o where o.client_request_id = v_req_id;
    if v_existing_conf is not null then
      return private.opening_receipt(v_existing_conf) || jsonb_build_object('idempotent_replay', true);
    end if;
    raise;
end
$$;

create or replace function private.get_account_opening(p_confirmation_number text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff core.staff := private.require_staff();
  v_err jsonb;
  v_member_number text;
begin
  v_err := private.check_permission(v_staff, 'accounts.view', null, 'View account opening');
  if v_err is not null then
    return v_err;
  end if;

  select m.member_number into v_member_number
  from core.account_openings o join core.members m on m.id = o.member_id
  where o.confirmation_number = upper(btrim(coalesce(p_confirmation_number, '')));
  if v_member_number is null then
    return private.fail(404, 'RF404', 'not_found', jsonb_build_object('confirmation_number', p_confirmation_number));
  end if;

  v_err := private.member_access_error(v_staff, v_member_number, 'account.opening_view');
  if v_err is not null then
    return v_err;
  end if;

  return private.opening_receipt(upper(btrim(p_confirmation_number)));
end
$$;
