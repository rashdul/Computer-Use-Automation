/**
 * A tiny server-rendered "legacy" member app for offline tests: plain HTML
 * forms, no test IDs, a label/value pair in bare divs, and switchable
 * interstitials. Lets discovery and replay be tested without Supabase or an LLM.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AppProfile } from "../safety.js";

export const MEMBERS: Record<string, { name: string; balance: string }> = {
  "1000001": { name: "Ada Lovelace", balance: "$1,234.56" },
  "1000002": { name: "Grace Hopper", balance: "$98,765.43" },
  "1000003": { name: "Grace Hopper", balance: "$10.00" }, // shared name: a name search is ambiguous
  "1000004": { name: "Alan Turing", balance: "$5,555.55" },
};

export interface Fixture {
  origin: string;
  /** A second site that is NOT on the allow-list; /away server-redirects to it. */
  outsideOrigin: string;
  /** Interstitial shown on the member page: none, a known notice, or an unknown dialog. */
  mode: "none" | "maintenance" | "survey";
  close(): Promise<void>;
}

const page = (body: string) => `<!doctype html><html><head><title>Fixture CU</title></head><body><main>${body}</main></body></html>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export async function startFixture(): Promise<Fixture> {
  const fixture = { mode: "none" } as Fixture;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (html: string, status = 200) => {
      res.writeHead(status, { "Content-Type": "text/html" });
      res.end(page(html));
    };
    if (url.pathname === "/login") {
      return send(`<h1>Sign in</h1><form method="post" action="/session">
        <label for="u">Username</label><input id="u" name="u">
        <label for="p">Password</label><input id="p" name="p" type="password">
        <button type="submit">Sign in</button></form>`);
    }
    if (url.pathname === "/away") {
      res.writeHead(302, { Location: `${fixture.outsideOrigin}/landing` });
      return res.end();
    }
    if (url.pathname === "/session" && req.method === "POST") {
      res.writeHead(303, { Location: "/search" });
      return res.end();
    }
    if (url.pathname === "/search") {
      const q = url.searchParams.get("q") ?? "";
      // Search by member number or by full name, like the real console.
      const hits = Object.entries(MEMBERS).filter(([id, m]) => id === q || m.name.toLowerCase() === q.toLowerCase());
      const rows = hits.map(([id, m]) => `<tr><td><a href="/members/${id}">${id}</a></td><td>${esc(m.name)}</td></tr>`).join("");
      const results = !q
        ? ""
        : hits.length
          ? `<table aria-label="Search results"><tr><th>Member #</th><th>Name</th></tr>${rows}</table>`
          : `<p>No members match “${esc(q)}”</p>`;
      return send(`<h1>Member search</h1><form role="search" action="/search">
        <label for="q">Search</label><input id="q" name="q" type="search" value="${esc(q)}">
        <button type="submit">Search</button></form>${results}
        <p>Tip: search by member number, e.g. <code>1000001</code></p>
        <a href="/away">Partner site</a>
        <iframe title="ad" src="https://ads.example.test/slot"></iframe>`); // off-origin ad frame, like real sites
    }
    const applied = url.pathname.match(/^\/members\/(\d{7})\/apply$/)?.[1];
    if (applied && req.method === "POST") {
      // A data-changing action, like opening an account.
      res.writeHead(303, { Location: `/members/${applied}/applied` });
      return res.end();
    }
    if (/^\/members\/\d{7}\/applied$/.test(url.pathname)) return send("<h1>Application received</h1>");
    const member = url.pathname.match(/^\/members\/(\d{7})$/)?.[1];
    if (member && MEMBERS[member]) {
      const dialog =
        fixture.mode === "maintenance"
          ? `<div role="alertdialog" aria-labelledby="d"><h2 id="d">Scheduled maintenance tonight</h2><button onclick="this.parentElement.remove()">Acknowledge</button></div>`
          : fixture.mode === "survey"
            ? `<div role="alertdialog" aria-labelledby="d"><h2 id="d">Customer survey</h2><button onclick="this.parentElement.remove()">Close survey</button></div>`
            : "";
      const tab = `<a href="#accounts">Accounts ${Number(member.slice(-1))}</a>`; // count differs per member
      return send(`<h1>Member ${member}</h1>${tab}<section><div>Current balance</div><div>${MEMBERS[member].balance}</div></section>
        <form method="post" action="/members/${member}/apply"><button>Submit application</button></form>${dialog}`);
    }
    send("<h1>Not found</h1>", 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fixture.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const outside = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(page("<h1>Somewhere else</h1><button>Do something</button>"));
  });
  await new Promise<void>((r) => outside.listen(0, "127.0.0.1", r));
  fixture.outsideOrigin = `http://127.0.0.1:${(outside.address() as AddressInfo).port}`;
  fixture.close = () => new Promise((r) => server.close(() => outside.close(() => r())));
  return fixture;
}

export function fixtureProfile(origin: string): AppProfile {
  return {
    id: "fixture-cu",
    policy: {
      allowedOrigins: [origin],
      allowedActions: ["click", "fill", "select", "press", "extract"],
      riskyTargetPatterns: ["sign out", "delete", "submit application"],
    },
    secrets: ["username", "password"],
    conditions: [
      { id: "member_not_found", kind: "business", when: { by: "text", text: "No members match" }, message: "No such member.", maxRecoveries: 2 },
      {
        id: "maintenance_notice",
        kind: "recoverable",
        when: { by: "role", role: "alertdialog", name: "Scheduled maintenance tonight" },
        message: "Informational notice.",
        recover: [{ by: "role", role: "button", name: "Acknowledge" }],
        maxRecoveries: 2,
      },
    ],
  };
}
