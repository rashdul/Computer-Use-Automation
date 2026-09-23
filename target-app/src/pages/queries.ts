import { useQuery } from "@tanstack/react-query";
import { useOutletContext } from "react-router";
import { api } from "../lib/api";
import type { MemberDetail } from "../lib/types";

export const keys = {
  member: (n: string) => ["member", n] as const,
  accounts: (n: string, closed: boolean) => ["member-accounts", n, closed] as const,
  account: (n: string, acct: string) => ["account", n, acct] as const,
  txns: (n: string, acct: string, f: unknown) => ["account-txns", n, acct, f] as const,
  notes: (n: string, page: number) => ["member-notes", n, page] as const,
  accessLog: (n: string, page: number) => ["member-access-log", n, page] as const,
  openContext: (n: string) => ["open-context", n] as const,
  opening: (c: string) => ["opening", c] as const,
};

export function useMemberQuery(memberNumber: string) {
  return useQuery({
    queryKey: keys.member(memberNumber),
    queryFn: () => api.member(memberNumber),
    staleTime: 60_000,
  });
}

/** Member detail loaded by MemberLayout, shared with its child routes. */
export function useMemberDetail(): MemberDetail {
  return useOutletContext<MemberDetail>();
}
