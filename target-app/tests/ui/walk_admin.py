"""Roles and Administration: teller denials, the admin password gate, every
admin section, segregation of duties, and a branch manager's restricted access."""

import re

from support import BASE_URL, expect, new_page, password_for, run, settle, shot, sign_in, sign_out

HAPPY = "1030966"
RESTRICTED = "1000672"
LEGAL_HOLD = "1002515"


def body(browser, page, r):
    # --- teller -----------------------------------------------------------------------
    sign_in(page, "jlin")
    r.expect(lambda: expect(page.get_by_role("link", name="Administration")).to_have_count(0), "teller doesn't see Administration")
    page.goto(f"{BASE_URL}/members/{HAPPY}")
    settle(page)
    r.expect(lambda: expect(page.get_by_role("button", name="Reveal")).to_have_count(0), "teller can't reveal SSNs")
    page.get_by_role("region", name="Member").get_by_role("button", name="Open sub-account").click()
    settle(page)
    r.expect(lambda: expect(page.get_by_role("heading", name="You don't have permission to do this")).to_be_visible(), "teller opening an account gets Permission denied")
    r.expect(lambda: expect(page.get_by_text("Open sub-accounts", exact=True)).to_be_visible(), "denial names the missing permission")
    shot(page, "70-teller-open-denied")
    page.goto(f"{BASE_URL}/admin")
    settle(page)
    r.expect(lambda: expect(page.get_by_role("heading", name="You don't have permission to do this")).to_be_visible(), "teller visiting /admin is denied by the server")
    shot(page, "71-teller-admin-denied")
    sign_out(page)
    page.context.close()

    # --- administrator --------------------------------------------------------------
    admin = new_page(browser, r)
    sign_in(admin, "dwhitfield")
    admin.get_by_role("link", name="Administration").click()
    settle(admin)
    r.expect(lambda: expect(admin.get_by_role("heading", name="Confirm your password")).to_be_visible(), "Administration asks for the password first")
    shot(admin, "72-admin-step-up")
    admin.get_by_label("Password", exact=True).fill("not-the-password")
    admin.get_by_role("button", name="Unlock Administration").click()
    r.expect(lambda: expect(admin.get_by_text("That password is incorrect.")).to_be_visible(), "wrong password is refused")
    admin.get_by_label("Password", exact=True).fill(password_for("dwhitfield"))
    admin.get_by_role("button", name="Unlock Administration").click()
    settle(admin, 500)
    r.expect(lambda: expect(admin.get_by_role("heading", name="Administration", exact=True)).to_be_visible(), "correct password unlocks Administration")
    r.expect(lambda: expect(admin.get_by_text("Posted transactions")).to_be_visible(), "overview shows data volumes")
    r.expect(lambda: expect(admin.get_by_role("heading", name="Environment status")).to_be_visible(), "overview shows environment status")
    shot(admin, "73-admin-overview", full_page=True)

    admin.get_by_role("link", name="Environment controls", exact=True).click()
    settle(admin)
    r.expect(lambda: expect(admin.get_by_role("heading", name="Environment controls")).to_be_visible(), "environment controls load")
    shot(admin, "74-admin-environment", full_page=True)

    admin.get_by_role("link", name="Staff & sessions").click()
    settle(admin)
    r.expect(lambda: expect(admin.get_by_role("table").first).to_contain_text("Adaeze Okafor"), "staff list loads")
    r.expect(lambda: expect(admin.get_by_label("Role for Dana Whitfield")).to_be_disabled(), "admins can't change their own role")
    shot(admin, "75-admin-staff", full_page=True)

    admin.get_by_role("link", name="Roles & permissions").click()
    settle(admin)
    box = admin.get_by_role("checkbox", name="Reveal full SSN for Teller")
    r.expect(lambda: expect(box).not_to_be_checked(), "matrix shows tellers can't reveal SSNs")
    box.check()
    r.expect(lambda: expect(admin.get_by_text("Granted “Reveal full SSN” to Teller")).to_be_visible(), "granting a permission confirms")
    settle(admin)
    admin.get_by_role("checkbox", name="Reveal full SSN for Teller").uncheck()
    r.expect(lambda: expect(admin.get_by_text("Revoked “Reveal full SSN” from Teller")).to_be_visible(), "revoking a permission confirms")
    r.expect(lambda: expect(admin.get_by_role("checkbox", name="Use Administration for System Administrator")).to_be_disabled(), "admins can't lock themselves out")
    shot(admin, "76-admin-permissions", full_page=True)

    admin.get_by_role("link", name="Products", exact=True).click()
    settle(admin)
    r.expect(lambda: expect(admin.get_by_label("Rate for 12-Month Share Certificate")).to_be_visible(), "product rates are editable")
    shot(admin, "77-admin-products", full_page=True)

    admin.get_by_role("link", name="Audit log").click()
    settle(admin)
    admin.get_by_label("Action").select_option("access.denied")
    admin.get_by_role("button", name="Apply").click()
    settle(admin)
    r.expect(lambda: expect(admin.get_by_role("table")).to_contain_text("Access denied"), "audit log filters to denials")
    admin.get_by_role("button", name=re.compile(r"^Show details for AUD-")).first.click()
    r.expect(lambda: expect(admin.locator("pre.details-json").first).to_contain_text("permission"), "audit rows expand to their details")
    shot(admin, "78-admin-audit")

    admin.get_by_role("link", name="Test data").click()
    settle(admin)
    r.expect(lambda: expect(admin.get_by_role("table")).to_contain_text("OFAC review pending"), "scenario catalogue lists the fixtures")
    shot(admin, "79-admin-test-data", full_page=True)

    admin.goto(f"{BASE_URL}/members/{HAPPY}/accounts/new")
    settle(admin)
    r.expect(lambda: expect(admin.get_by_role("heading", name="You don't have permission to do this")).to_be_visible(), "administrators can't open accounts (segregation of duties)")
    sign_out(admin)
    admin.context.close()

    # --- branch manager ---------------------------------------------------------------
    mgr = new_page(browser, r)
    sign_in(mgr, "mreyes")
    mgr.goto(f"{BASE_URL}/members/{RESTRICTED}")
    settle(mgr)
    r.expect(lambda: expect(mgr.get_by_role("region", name="Member").get_by_text(re.compile("Restricted · Employee account"))).to_be_visible(), "branch manager opens the restricted record")
    mgr.get_by_role("link", name="Access log").click()
    settle(mgr)
    r.expect(lambda: expect(mgr.get_by_role("table")).to_contain_text("Blocked: restricted record"), "access log shows earlier denied attempts")
    shot(mgr, "80-manager-access-log")
    mgr.goto(f"{BASE_URL}/members/{LEGAL_HOLD}/accounts/new")
    settle(mgr)
    r.expect(lambda: expect(mgr.get_by_text("A legal hold is in place on this membership", exact=False)).to_be_visible(), "legal hold blocks account opening even for managers")
    shot(mgr, "81-manager-legal-hold")
    sign_out(mgr)


run("admin", body)
