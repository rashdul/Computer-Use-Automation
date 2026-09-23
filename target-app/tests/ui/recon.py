"""Reconnaissance: sign-in page, validation, bad password, sign-in, landing page."""

from support import BASE_URL, expect, run, settle, shot, sign_in, sign_out


def body(browser, page, r):
    page.goto(f"{BASE_URL}/members")
    settle(page)
    r.expect(lambda: expect(page).to_have_url(f"{BASE_URL}/login?next=%2Fmembers"), "unauthenticated visit redirects to sign-in with next=")
    shot(page, "01-login")

    page.get_by_role("button", name="Sign in").click()
    r.expect(lambda: expect(page.get_by_text("Enter your username.")).to_be_visible(), "empty sign-in shows field errors")
    shot(page, "02-login-validation")

    page.get_by_label("Username").fill("aokafor")
    page.get_by_label("Password", exact=True).fill("definitely-wrong-password")
    page.get_by_role("button", name="Sign in").click()
    r.expect(lambda: expect(page.get_by_text("The username or password is incorrect.")).to_be_visible(), "wrong password is rejected with a clear message")
    shot(page, "03-login-bad-password")

    sign_in(page, "aokafor", "%2Fmembers")
    r.expect(lambda: expect(page.get_by_role("heading", name="Member search")).to_be_visible(), "lands on member search after sign-in")
    r.expect(lambda: expect(page.get_by_text("Adaeze Okafor")).to_be_visible(), "user menu shows the signed-in staff member")
    shot(page, "04-member-search-empty")
    sign_out(page)


run("recon", body)
