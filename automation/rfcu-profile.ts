import type { InputValues } from "./schema.js";

export const GENERAL_ROUTES = [
  "/login",
  "/session-expired",
  "/members",
  "/products",
  "/activity",
  "/open-account",
  "/members/{{member_id}}",
  "/members/{{member_id}}/accounts",
  "/members/{{member_id}}/accounts/:account",
  "/members/{{member_id}}/notes",
  "/members/{{member_id}}/access-log",
  "/members/{{member_id}}/accounts/new",
  "/members/{{member_id}}/accounts/new/review",
  "/members/{{member_id}}/accounts/new/confirmation/:receipt",
  "/admin",
  "/admin/environment",
  "/admin/staff",
  "/admin/permissions",
  "/admin/products",
  "/admin/audit",
  "/admin/test-data",
];
export function matchRoute(
  template: string,
  path: string,
  inputs: InputValues,
) {
  if (
    template.includes("{{member_id}}") &&
    !/^\d{7}$/.test(inputs.member_id ?? "")
  )
    return false;
  const expanded = template.replaceAll("{{member_id}}", inputs.member_id ?? "");
  const pattern = expanded
    .split(":account")
    .map((s) =>
      s
        .split(":receipt")
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[A-Za-z0-9-]{1,80}"),
    )
    .join(`${inputs.member_id}-[A-Z][0-9]{2}`);
  return new RegExp("^" + pattern + "$").test(path);
}
export function permittedQuery(
  path: string,
  key: string,
  value: string,
  inputs: InputValues,
) {
  if (path === "/members" && key === "q")
    return value === (inputs.member_name ?? inputs.member_id);
  if (key === "compose" && /\/notes$/.test(path)) return value === "1";
  const keys = [
    "status",
    "branch",
    "sort",
    "offset",
    "from",
    "to",
    "direction",
    "search",
    "outcome",
    "actor",
    "action",
    "member",
    "closed",
  ];
  return (
    keys.includes(key) && value.length <= 100 && !/[\x00-\x1f<>]/.test(value)
  );
}
export const GENERAL_READ_RPC = new Set([
  "get_member_notes",
  "get_member_access_log",
  "get_products",
  "get_my_activity",
  "get_open_account_context",
  "lookup_member_brief",
  "get_account_opening",
  "admin_get_overview",
  "admin_list_staff",
  "admin_list_sessions",
  "admin_get_permissions",
  "admin_get_environment",
  "admin_list_products",
  "admin_search_audit",
  "admin_get_test_scenarios",
]);
// An approved action permits at most one mutation RPC, scoped to the current page.
export function mutationRpcs(path: string): string[] {
  if (/\/notes$/.test(path)) return ["add_member_note"];
  if (/\/accounts\/new\/review$/.test(path)) return ["open_sub_account"];
  if (path === "/admin/staff")
    return ["admin_update_staff", "admin_end_sessions"];
  if (path === "/admin/permissions") return ["admin_set_role_permission"];
  if (path === "/admin/environment")
    return ["admin_update_environment", "admin_reset_environment"];
  if (path === "/admin/products") return ["admin_update_product"];
  if (path === "/admin/test-data") return ["admin_reset_scenarios"];
  return [];
}
export const PRIVATE_LABEL =
  /(?:^Member$)|\b(ssn|social security|password|username|token|email|phone|mobile|birth|address|taxpayer|author|actor|name|nickname|owner|beneficiary)\b/i;
export const SAFE_BUTTON =
  /^(Sign in|Search|Try again|Continue(?: to review)?|Open sub-account|Back|Cancel|Close|Dismiss|Acknowledge|OK, got it|Remind me later|Next(?: page)?|Previous(?: page)?|Clear(?: search| filters)?|Apply(?: filters)?|Add note|Review(?: .*)?|Select(?: .*)?|Choose(?: .*)?|Edit(?: details)?|Add joint owner|Remove joint owner)$/i;
