import type {
  AccountStatus,
  AlertType,
  InterruptKind,
  InterruptTrigger,
  KycStatus,
  MemberStatus,
  MembershipType,
  ProductCategory,
  Role,
  Scope,
} from "./types";

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

export const ROLE_LABEL: Record<Role, string> = {
  teller: "Teller",
  member_service_rep: "Member Service Representative",
  branch_manager: "Branch Manager",
  compliance_officer: "Compliance Officer",
  system_admin: "System Administrator",
};

export const MEMBER_STATUS: Record<MemberStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "ok" },
  dormant: { label: "Dormant", tone: "warn" },
  closed: { label: "Closed", tone: "neutral" },
  deceased: { label: "Deceased", tone: "bad" },
};

export const MEMBERSHIP_TYPE: Record<MembershipType, string> = {
  individual: "Individual",
  joint: "Joint",
  minor: "Minor (custodial)",
  business: "Business",
  trust: "Trust",
};

export const KYC: Record<KycStatus, { label: string; tone: Tone }> = {
  verified: { label: "Verified", tone: "ok" },
  pending_review: { label: "Pending review", tone: "warn" },
  expired: { label: "Expired", tone: "bad" },
  failed: { label: "Failed", tone: "bad" },
};

export const ACCOUNT_STATUS: Record<AccountStatus, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "ok" },
  dormant: { label: "Dormant", tone: "warn" },
  restricted: { label: "Frozen", tone: "bad" },
  closed: { label: "Closed", tone: "neutral" },
};

export const CATEGORY_LABEL: Record<ProductCategory, string> = {
  share: "Savings",
  share_draft: "Checking",
  money_market: "Money market",
  club: "Clubs",
  certificate: "Share certificates",
  ira: "IRAs",
  loan: "Loans & lines",
};

export const ALERT_LABEL: Record<AlertType, string> = {
  ofac_review: "OFAC review",
  fraud_alert: "Fraud alert",
  deceased: "Deceased",
  address_undeliverable: "Undeliverable address",
  id_expired: "ID expired",
  bankruptcy: "Bankruptcy",
  legal_hold: "Legal hold",
  do_not_contact: "Do not contact",
};

export const RISK: Record<string, { label: string; tone: Tone }> = {
  low: { label: "Low", tone: "ok" },
  moderate: { label: "Moderate", tone: "warn" },
  high: { label: "High", tone: "bad" },
};

export const PREFERRED_CONTACT: Record<string, string> = {
  email: "Email",
  mobile: "Mobile phone",
  home_phone: "Home phone",
  mail: "Mail",
};

export const MATURITY_OPTION: Record<string, string> = {
  renew: "Renew for the same term",
  transfer_to_share: "Transfer to S00 at maturity",
  mail_check: "Mail a check at maturity",
};

export const DIVIDEND_OPTION: Record<string, string> = {
  compound: "Add to the certificate (compound)",
  transfer_to_share: "Transfer monthly to S00",
};

export const FUNDING_METHOD: Record<string, string> = {
  transfer: "Transfer from another sub-account",
  cash: "Cash",
  check: "Check",
  none: "No opening deposit",
};

export const SIGNATURE_METHOD: Record<string, string> = {
  signature_pad: "Signed on the signature pad",
  wet_signature: "Wet signature card on file",
  e_sign: "E-signed (DocuSign)",
};

export const EXPECTED_DEPOSITS: Record<string, string> = {
  under_1000: "Under $1,000",
  "1000_5000": "$1,000 – $5,000",
  "5000_10000": "$5,000 – $10,000",
  over_10000: "Over $10,000",
};

export const SOURCE_OF_FUNDS: Record<string, string> = {
  employment: "Employment income",
  savings: "Existing savings",
  retirement: "Retirement or pension",
  gift_inheritance: "Gift or inheritance",
  business: "Business income",
  other: "Other",
};

export const ACCOUNT_PURPOSES = [
  "Everyday spending",
  "Emergency savings",
  "Long-term savings",
  "Retirement savings",
  "Education savings",
  "Saving for a purchase",
  "Holiday or vacation savings",
];

export const BENEFICIARY_RELATIONSHIPS = ["Spouse", "Child", "Parent", "Sibling", "Grandchild", "Niece/Nephew", "Domestic partner", "Friend", "Trust"];

export const TXN_TYPE: Record<string, string> = {
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
  dividend: "Dividend",
  fee: "Fee",
  ach_credit: "ACH credit",
  ach_debit: "ACH debit",
  card_purchase: "Card purchase",
  atm_withdrawal: "ATM withdrawal",
  check_paid: "Check paid",
  check_deposit: "Check deposit",
  loan_disbursement: "Advance",
  loan_payment: "Payment",
  interest_charge: "Interest",
  adjustment: "Adjustment",
};

export const CHANNEL: Record<string, string> = {
  branch: "Branch",
  atm: "ATM",
  online: "Online banking",
  mobile: "Mobile app",
  ach: "ACH",
  card: "Card network",
  system: "System",
};

export const SCOPE_LABEL: Record<Scope, string> = {
  all: "All member requests",
  search: "Member search",
  member: "Member profiles & notes",
  accounts: "Accounts & transactions",
  account_opening: "Sub-account opening",
};

export const TRIGGER_LABEL: Record<InterruptTrigger, string> = {
  random: "Any screen (random)",
  sign_in: "Right after sign-in",
  member_search: "Member search",
  member_details: "Member overview",
  accounts: "Accounts tab",
  open_sub_account: "Open sub-account form",
  review: "Review step",
};

export const INTERRUPT_LABEL: Record<InterruptKind, string> = {
  maintenance_notice: "Scheduled maintenance notice",
  compliance_attestation: "BSA/AML attestation reminder",
  password_expiry: "Password expiry warning",
  printer_offline: "Receipt printer offline",
  duplicate_session: "Signed in on another workstation",
};

export const AUDIT_ACTIONS: { value: string; label: string }[] = [
  { value: "auth", label: "Sign-in & session" },
  { value: "member.search", label: "Member search" },
  { value: "member.view", label: "Member viewed" },
  { value: "member.ssn_revealed", label: "SSN revealed" },
  { value: "member.note_added", label: "Note added" },
  { value: "account", label: "Account activity" },
  { value: "account.opened", label: "Sub-account opened" },
  { value: "access.denied", label: "Access denied" },
  { value: "admin", label: "Administration changes" },
];

export function actionLabel(action: string): string {
  const map: Record<string, string> = {
    "auth.sign_in": "Signed in",
    "auth.sign_out": "Signed out",
    "auth.idle_timeout": "Session timed out",
    "auth.step_up": "Password confirmed",
    "member.search": "Member search",
    "member.view": "Member viewed",
    "member.ssn_revealed": "SSN revealed",
    "member.note_added": "Note added",
    "account.view": "Account viewed",
    "account.opened": "Sub-account opened",
    "account.open": "Opening blocked",
    "access.denied": "Access denied",
    "admin.environment_updated": "Environment changed",
    "admin.environment_reset": "Environment reset",
    "admin.staff_updated": "Staff updated",
    "admin.sessions_ended": "Sessions ended",
    "admin.permission_changed": "Permission changed",
    "admin.product_updated": "Product updated",
    "admin.scenarios_reset": "Test data reset",
  };
  return map[action] ?? action;
}
