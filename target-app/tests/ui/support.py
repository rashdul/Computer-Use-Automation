"""Shared helpers for the UI walkthroughs (Playwright, sync API).

Locators use only what a person sees — labels, roles, and visible text —
because the console deliberately has no test IDs.

Passwords are read from target-app/STAFF_CREDENTIALS.local.md (git-ignored)
and are never printed.
"""

from __future__ import annotations

import json
import re
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

from playwright.sync_api import Browser, ConsoleMessage, Page, expect, sync_playwright

APP_ROOT = Path(__file__).resolve().parents[2]
BASE_URL = "http://localhost:5173"
SHOTS = APP_ROOT / "test-output" / "screenshots"
CREDENTIALS = APP_ROOT / "STAFF_CREDENTIALS.local.md"
VIEWPORT = {"width": 1440, "height": 900}

expect.set_options(timeout=15_000)


def password_for(username: str) -> str:
    for line in CREDENTIALS.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\| `([^`]+)` \|.*\| `([^`]+)` \|$", line)
        if m and m.group(1) == username:
            return m.group(2)
    raise SystemExit(f"No credentials for {username} in {CREDENTIALS.name}")


@dataclass
class Report:
    name: str
    results: list[tuple[bool, str]] = field(default_factory=list)
    console_errors: list[str] = field(default_factory=list)

    def check(self, ok: bool, label: str) -> bool:
        self.results.append((ok, label))
        print(f"  {'PASS' if ok else 'FAIL'}  {label}", flush=True)
        return ok

    def expect(self, fn, label: str) -> bool:
        try:
            fn()
            return self.check(True, label)
        except Exception as e:  # noqa: BLE001 — record and continue the walkthrough
            msg = str(e).splitlines()[0][:200]
            return self.check(False, f"{label} — {msg}")

    def summary(self) -> int:
        failed = [r for r in self.results if not r[0]]
        print(f"\n{self.name}: {len(self.results) - len(failed)}/{len(self.results)} checks passed")
        if self.console_errors:
            print(f"Console errors ({len(self.console_errors)}):")
            for e in self.console_errors[:15]:
                print("   ", e[:240])
        return 1 if failed else 0


_UNROLL = ".shell{height:auto!important;min-height:100vh}.shell__content{overflow:visible!important}.flow-aside{position:static!important}"


def shot(page: Page, name: str, full_page: bool = False) -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    if not full_page:
        page.screenshot(path=str(SHOTS / f"{name}.png"))
        return
    # the console scrolls inside its content pane, not the document; unroll it for a full capture
    page.evaluate("css => { const s = document.createElement('style'); s.id = '__unroll'; s.textContent = css; document.head.appendChild(s); }", _UNROLL)
    page.wait_for_timeout(100)
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)
    page.evaluate("() => document.getElementById('__unroll')?.remove()")


def settle(page: Page, ms: int = 250) -> None:
    """Wait for network quiet and for 150–250 ms transitions to finish."""
    try:
        page.wait_for_load_state("networkidle", timeout=15_000)
    except Exception:  # noqa: BLE001 — long-polling pages may never go idle
        pass
    page.wait_for_timeout(ms)


@contextmanager
def browser_session(report: Report) -> Iterator[tuple[Browser, Page]]:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport=VIEWPORT, device_scale_factor=1, locale="en-US", timezone_id="America/New_York")
        page = context.new_page()

        def on_console(msg: ConsoleMessage) -> None:
            if msg.type == "error":
                report.console_errors.append(msg.text)

        page.on("console", on_console)
        page.on("pageerror", lambda err: report.console_errors.append(f"pageerror: {err}"))
        try:
            yield browser, page
        finally:
            browser.close()


def new_page(browser: Browser, report: Report) -> Page:
    context = browser.new_context(viewport=VIEWPORT, device_scale_factor=1, locale="en-US", timezone_id="America/New_York")
    page = context.new_page()
    page.on("console", lambda m: m.type == "error" and report.console_errors.append(m.text))
    page.on("pageerror", lambda err: report.console_errors.append(f"pageerror: {err}"))
    return page


def sign_in(page: Page, username: str, next_path: str = "") -> None:
    page.goto(f"{BASE_URL}/login" + (f"?next={next_path}" if next_path else ""))
    page.get_by_label("Username").fill(username)
    page.get_by_label("Password", exact=True).fill(password_for(username))
    page.get_by_role("button", name="Sign in").click()
    page.wait_for_url(re.compile(r"^(?!.*/login).*$"), timeout=20_000)
    settle(page)


def sign_out(page: Page) -> None:
    """End the session through the UI so test runs don't leave sessions behind."""
    menu = page.get_by_role("button", name=re.compile(r"(Member Service|Teller|Manager|Officer|Administrator)"))
    if not menu.count():
        return
    menu.first.click()
    page.get_by_role("menuitem", name="Sign out").click()
    page.wait_for_url(re.compile(r"/login"), timeout=15_000)


def dismiss_interrupts(page: Page) -> None:
    """Clear any unexpected dialog the environment injected."""
    for name in ["Acknowledge", "OK, got it", "Remind me later", "Dismiss", "This was me"]:
        btn = page.get_by_role("alertdialog").get_by_role("button", name=name)
        if btn.count():
            btn.first.click()
            page.wait_for_timeout(300)
            return


def run(name: str, body) -> None:
    report = Report(name)
    print(f"\n=== {name} ===", flush=True)
    started = time.time()
    try:
        with browser_session(report) as (browser, page):
            body(browser, page, report)
    except Exception as e:  # noqa: BLE001
        report.check(False, f"walkthrough crashed: {e}")
    print(f"({time.time() - started:.0f}s)")
    sys.exit(report.summary())


def dump(obj) -> str:
    return json.dumps(obj, indent=1)[:600]
