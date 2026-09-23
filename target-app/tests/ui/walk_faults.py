"""Fault injection and session handling, driven the way a UAT lead would: an
administrator changes Environment controls in one browser while a member
service rep works in another.

Covers slow loading, request timeouts, service outages, every unexpected
dialog, the maintenance banner, a timeout while opening an account (and the
safe retry), an administrator ending sessions mid-application (and resuming
it after signing in again), a reload after the session ended, and the idle
timeout. Environment controls are reset at the end; run reset_scenarios.py
afterwards to reverse the accounts this opens.
"""

import re

from playwright.sync_api import Page

from support import BASE_URL, expect, new_page, password_for, run, settle, shot, sign_in, sign_out

HAPPY = "1030966"
JOINT = "1000021"
MANY = "1057101"

# dialog type (as labelled in Environment controls) → the dialog's title
DIALOGS = {
    "Scheduled maintenance notice": "Scheduled maintenance tonight",
    "BSA/AML attestation reminder": "Annual BSA/AML attestation due",
    "Password expiry warning": "Your password expires in 3 days",
    "Receipt printer offline": "Receipt printer not responding",
    "Signed in on another workstation": "Signed in on another workstation",
}


# --- administrator helpers ----------------------------------------------------------


def open_environment(admin: Page) -> None:
    sign_in(admin, "dwhitfield")
    admin.get_by_role("link", name="Administration").click()
    admin.get_by_label("Password", exact=True).fill(password_for("dwhitfield"))
    admin.get_by_role("button", name="Unlock Administration").click()
    admin.get_by_role("link", name="Environment controls", exact=True).click()
    expect(admin.get_by_role("button", name="Save changes")).to_be_visible()


def save(admin: Page) -> None:
    button = admin.get_by_role("button", name="Save changes")
    if not button.is_enabled():
        return  # the form already matches
    button.click()
    toast = admin.get_by_role("status").filter(has_text="Environment controls saved")
    expect(toast).to_be_visible()
    toast.get_by_role("button", name="Dismiss notification").click()


def reset_environment(admin: Page) -> None:
    admin.get_by_role("button", name="Reset to defaults").click()
    admin.get_by_role("dialog", name="Reset environment controls?").get_by_role("button", name="Reset to defaults").click()
    expect(admin.get_by_role("status").filter(has_text="Environment reset to defaults")).to_be_visible()


def latency_mode(admin: Page, mode: str) -> None:
    admin.get_by_role("radiogroup", name="Latency mode").get_by_text(mode, exact=True).click()


def only_dialog(admin: Page, kind: str) -> None:
    group = admin.get_by_role("group", name="Dialog types")
    for label in DIALOGS:
        group.get_by_label(label).set_checked(label == kind)


def end_other_sessions(admin: Page) -> None:
    admin.get_by_role("button", name="End all other sessions now").click()
    admin.get_by_role("dialog", name="End every other staff session?").get_by_role("button", name="End sessions").click()
    expect(admin.get_by_role("status").filter(has_text=re.compile(r"Ended \d+ sessions?"))).to_be_visible()


# --- member service rep helpers -----------------------------------------------------


def pick_up(msr: Page) -> None:
    """Consoles pick up environment changes on a 30-second heartbeat or when the
    window regains focus; simulate the rep clicking back into the window."""
    with msr.expect_response(lambda resp: resp.url.endswith("/rpc/session_heartbeat")):
        msr.evaluate("() => window.dispatchEvent(new Event('focus'))")
    msr.wait_for_timeout(200)


def select_account(page: Page, label: str, account_number: str) -> None:
    select = page.get_by_label(label, exact=True)
    value = select.locator("option", has_text=account_number).first.get_attribute("value")
    select.select_option(value=value)


def fill_application(msr: Page, product: str, amount: str) -> None:
    """Open sub-account form → review, funded by transfer from the base share."""
    msr.goto(f"{BASE_URL}/members/{HAPPY}/accounts/new")
    settle(msr)
    msr.get_by_role("radio", name=re.compile(rf"^{re.escape(product)}")).check()
    msr.get_by_role("radio", name="Transfer from another sub-account").check()
    msr.get_by_label("Deposit amount").fill(amount)
    select_account(msr, "Transfer from", f"{HAPPY}-S00")
    msr.get_by_role("radio", name="Electronic").check()
    msr.get_by_label("Purpose of the account").select_option("Holiday or vacation savings")
    msr.get_by_label("Expected monthly deposits").select_option("under_1000")
    msr.get_by_label("Source of funds").select_option("savings")
    msr.get_by_role("button", name="Continue to review").click()
    expect(msr.get_by_role("heading", name="Review and open")).to_be_visible()
    for box in msr.get_by_role("group", name="The member received").get_by_role("checkbox").all():
        box.check()
    msr.get_by_role("radio", name="Signed on the signature pad").check()


def body(browser, admin, r):
    open_environment(admin)
    reset_environment(admin)

    msr = new_page(browser, r)
    sign_in(msr, "aokafor")

    # --- slow loading ---------------------------------------------------------------
    latency_mode(admin, "Fixed")
    admin.get_by_label("Added delay (ms)").fill("6000")
    admin.get_by_label("Delay applies to").select_option(label="Member profiles & notes")
    admin.get_by_label("Show notice after (ms)").fill("1500")
    shot(admin, "90-env-latency", full_page=True)
    save(admin)

    msr.goto(f"{BASE_URL}/members/{HAPPY}")
    notice = msr.get_by_role("status").filter(has_text="Still loading the member record")
    r.expect(lambda: expect(notice).to_be_visible(timeout=5_000), "slow-loading notice appears after the threshold")
    msr.wait_for_timeout(1_200)
    shot(msr, "91-slow-loading")
    r.expect(lambda: expect(msr.get_by_role("region", name="Member")).to_be_visible(timeout=15_000), "the record arrives after the delay")
    r.expect(lambda: expect(notice).to_have_count(0), "the notice clears once the record loads")

    # --- request timeout ------------------------------------------------------------
    admin.get_by_label("Added delay (ms)").fill("9000")
    admin.get_by_label("Time out after (ms)").fill("4000")
    save(admin)
    msr.goto(f"{BASE_URL}/members/{JOINT}")
    timed_out = msr.get_by_role("alert").filter(has_text="The request timed out")
    r.expect(lambda: expect(timed_out).to_be_visible(timeout=10_000), "a request past the timeout shows a timeout error")
    r.expect(lambda: expect(timed_out).to_contain_text(re.compile(r"Reference TMO-[A-Z0-9]{8}")), "the timeout carries a Help Desk reference")
    shot(msr, "92-request-timeout")
    latency_mode(admin, "Off")
    save(admin)
    pick_up(msr)
    timed_out.get_by_role("button", name="Try again").click()
    r.expect(lambda: expect(msr.get_by_role("region", name="Member")).to_be_visible(), "Try again recovers once the core answers")

    # --- service unavailable --------------------------------------------------------
    admin.get_by_label("Failure rate (%)").fill("100")
    admin.get_by_label("Failures apply to").select_option(label="Accounts & transactions")
    save(admin)
    # a member not opened yet this session, so nothing is served from cache
    msr.goto(f"{BASE_URL}/members/{MANY}/accounts")
    outage = msr.get_by_role("alert").filter(has_text="Core banking service unavailable")
    r.expect(lambda: expect(outage).to_be_visible(), "failure injection shows a service-unavailable error")
    r.expect(lambda: expect(outage).to_contain_text(re.compile(r"Reference SVC-[A-Z0-9]{8}")), "the outage carries a Help Desk reference")
    shot(msr, "93-service-unavailable")
    admin.get_by_label("Failure rate (%)").fill("0")
    save(admin)
    pick_up(msr)
    outage.get_by_role("button", name="Try again").click()
    r.expect(lambda: expect(msr.get_by_role("table").first).to_contain_text(f"{MANY}-S00"), "accounts load after the outage clears")

    # --- unexpected dialogs ---------------------------------------------------------
    admin.get_by_label("Show unexpected dialogs").check()
    admin.get_by_label("Where").select_option(label="Member overview")
    admin.get_by_label("Chance (%)").fill("100")
    admin.get_by_label("Appears after (ms)").fill("400")
    admin.get_by_label("Once per session").uncheck()
    for n, (kind, title) in enumerate(DIALOGS.items()):
        only_dialog(admin, kind)
        save(admin)
        msr.goto(f"{BASE_URL}/members/{HAPPY}")
        dialog = msr.get_by_role("alertdialog", name=title)
        if not r.expect(lambda: expect(dialog).to_be_visible(), f"“{kind}” interrupts the member overview"):
            continue
        msr.wait_for_timeout(300)
        shot(msr, f"94-dialog-{n + 1}")
        msr.keyboard.press("Escape")
        msr.wait_for_timeout(250)
        if kind == "Scheduled maintenance notice":
            r.expect(lambda: expect(dialog).to_be_visible(), "Escape doesn't dismiss an interruption")
            dialog.get_by_role("button", name="Acknowledge").click()
        elif kind == "BSA/AML attestation reminder":
            dialog.get_by_role("button", name="Attest now").click()
            step = msr.get_by_role("alertdialog", name="Confirm your BSA/AML attestation")
            submit = step.get_by_role("button", name="Submit attestation")
            r.expect(lambda: expect(submit).to_be_disabled(), "attestation can't be submitted unticked")
            step.get_by_role("checkbox").check()
            submit.click()
            r.expect(lambda: expect(msr.get_by_text("Attestation recorded")).to_be_visible(), "attestation confirms with a toast")
            dialog = step
        elif kind == "Password expiry warning":
            dialog.get_by_role("button", name="OK, got it").click()
        elif kind == "Receipt printer offline":
            dialog.get_by_role("button", name="Retry connection").click()
            r.expect(lambda: expect(dialog).to_contain_text("Still offline"), "printer retry ends in a still-offline message")
            shot(msr, "94-dialog-4b-printer-retry")
            dialog.get_by_role("button", name="Dismiss").click()
        else:
            dialog.get_by_role("button", name="Report to Help Desk").click()
            r.expect(lambda: expect(msr.get_by_text("Reported to the Help Desk")).to_be_visible(), "reporting confirms with a toast")
        r.expect(lambda: expect(dialog).to_have_count(0), f"“{kind}” closes and returns to the overview")
    admin.get_by_label("Show unexpected dialogs").uncheck()

    # --- maintenance banner ---------------------------------------------------------
    notice_text = "Core processing is unavailable Saturday 11:00 PM – 2:00 AM ET. Finish account openings by 10:30 PM."
    admin.get_by_label("Banner text").fill(notice_text)
    save(admin)
    pick_up(msr)
    banner = msr.get_by_role("status").filter(has_text=notice_text)
    r.expect(lambda: expect(banner).to_be_visible(), "maintenance banner appears on every screen")
    shot(msr, "95-maintenance-banner")
    admin.get_by_label("Banner text").fill("")
    save(admin)
    pick_up(msr)
    r.expect(lambda: expect(banner).to_have_count(0), "clearing the banner removes it")

    # --- timeout while opening an account, then a safe retry --------------------------
    fill_application(msr, "Holiday Club", "40")
    admin.get_by_role("button", name="Timeouts on opening").click()
    save(admin)
    pick_up(msr)
    msr.get_by_role("button", name="Open account").click()
    r.expect(lambda: expect(msr.get_by_role("button", name="Opening account…")).to_be_visible(), "Open account shows progress while waiting")
    failed = msr.get_by_role("alert").filter(has_text="The request timed out")
    r.expect(lambda: expect(failed).to_be_visible(timeout=15_000), "opening times out after 8 seconds")
    r.expect(lambda: expect(msr.get_by_text("It's safe to try again")).to_be_visible(), "the review says a retry won't open a second account")
    shot(msr, "96-open-timeout", full_page=True)
    latency_mode(admin, "Off")
    save(admin)
    pick_up(msr)
    failed.get_by_role("button", name="Try again").click()
    msr.wait_for_url(re.compile(r"/confirmation/OA\d{6}-[A-Z0-9]{6}$"), timeout=20_000)
    r.expect(lambda: expect(msr.get_by_role("heading", name="Holiday Club opened")).to_be_visible(), "the retry opens the account")

    # --- administrator ends the session mid-application --------------------------------
    fill_application(msr, "Vacation Club", "60")
    end_other_sessions(admin)
    msr.get_by_role("button", name="Open account").click()
    r.expect(lambda: expect(msr.get_by_role("heading", name="Your session has ended")).to_be_visible(), "the next action after revocation shows Session ended")
    shot(msr, "97-session-ended")
    msr.get_by_role("link", name="Sign in again").click()
    msr.get_by_label("Username").fill("aokafor")
    msr.get_by_label("Password", exact=True).fill(password_for("aokafor"))
    msr.get_by_role("button", name="Sign in").click()
    r.expect(lambda: expect(msr.get_by_role("heading", name="Review and open")).to_be_visible(), "signing in again returns to the review step")
    r.expect(lambda: expect(msr.get_by_role("main")).to_contain_text("Vacation Club"), "the application survived the expired session")
    shot(msr, "98-resumed-review", full_page=True)
    msr.get_by_role("button", name="Open account").click()
    msr.wait_for_url(re.compile(r"/confirmation/OA\d{6}-[A-Z0-9]{6}$"), timeout=20_000)
    r.expect(lambda: expect(msr.get_by_role("heading", name="Vacation Club opened")).to_be_visible(), "the resumed application opens")

    # --- reloading after the session ended ----------------------------------------------
    end_other_sessions(admin)
    msr.reload()
    r.expect(lambda: expect(msr.get_by_role("heading", name="Your session has ended")).to_be_visible(), "a reload after revocation explains why")
    sign_in(msr, "aokafor")
    msr.goto(f"{BASE_URL}/members/{HAPPY}")
    settle(msr)

    # --- idle timeout ---------------------------------------------------------------------
    admin.get_by_label("Idle timeout (minutes)").fill("1")
    admin.get_by_label("Warning (seconds)").fill("20")
    save(admin)
    pick_up(msr)
    warning = msr.get_by_role("alertdialog", name="Your session is about to end")
    r.expect(lambda: expect(warning).to_be_visible(timeout=75_000), "idle warning counts down before sign-out")
    shot(msr, "99-idle-warning")
    warning.get_by_role("button", name="Stay signed in").click()
    r.expect(lambda: expect(warning).to_have_count(0), "Stay signed in keeps the session")
    r.expect(lambda: expect(warning).to_be_visible(timeout=75_000), "the warning returns after another idle period")
    r.expect(
        lambda: expect(msr.get_by_role("heading", name="You were signed out after a period of inactivity")).to_be_visible(timeout=40_000),
        "ignoring the warning signs the rep out",
    )
    r.expect(lambda: expect(msr).to_have_url(re.compile(r"reason=idle&next=%2Fmembers%2F" + HAPPY)), "the sign-out remembers where the rep was")
    msr.wait_for_timeout(400)
    shot(msr, "100-idle-signed-out")
    msr.get_by_role("link", name="Sign in again").click()
    msr.get_by_label("Username").fill("aokafor")
    msr.get_by_label("Password", exact=True).fill(password_for("aokafor"))
    msr.get_by_role("button", name="Sign in").click()
    r.expect(lambda: expect(msr.get_by_role("region", name="Member")).to_be_visible(), "signing in again returns to the member")

    # the administrator sat idle through all of that, so their console timed out too
    r.expect(
        lambda: expect(admin.get_by_role("heading", name="You were signed out after a period of inactivity")).to_be_visible(timeout=5_000),
        "the idle timeout applies to administrators as well",
    )
    open_environment(admin)
    reset_environment(admin)
    shot(admin, "101-env-reset", full_page=True)
    sign_out(msr)
    sign_out(admin)


run("faults", body)
