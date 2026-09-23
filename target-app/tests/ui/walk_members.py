"""Member Search → Member Details → Accounts → Account ledger, plus notes and
the member-not-found and restricted-record outcomes. Signs in as an MSR."""

import re

from support import BASE_URL, expect, run, settle, shot, sign_in

HAPPY = "1030966"
RESTRICTED = "1000672"


def body(browser, page, r):
    sign_in(page, "aokafor")

    # --- search ---------------------------------------------------------------
    search = page.get_by_role("searchbox", name="Search")
    search.fill("smith")
    page.get_by_role("button", name="Search", exact=True).click()
    settle(page)
    r.expect(lambda: expect(page.get_by_role("table")).to_contain_text("Smith"), "name search lists matching members")
    r.expect(lambda: expect(page.get_by_text(re.compile(r"of [\d,]+ members"))).to_be_visible(), "results are paginated with a range")
    shot(page, "10-search-results")

    page.get_by_role("button", name="Next").click()
    settle(page)
    r.expect(lambda: expect(page).to_have_url(re.compile(r"offset=25")), "next page is reflected in the URL")

    search.fill("zzqxv")
    page.get_by_role("button", name="Search", exact=True).click()
    settle(page)
    r.expect(lambda: expect(page.get_by_text("No members match “zzqxv”")).to_be_visible(), "no-results state explains what to try")
    shot(page, "11-search-no-results")

    search.fill("12345")
    page.get_by_role("button", name="Search", exact=True).click()
    settle(page)
    r.expect(lambda: expect(page.get_by_text("Member numbers are 7 digits.", exact=False)).to_be_visible(), "short member number gets a validation message")
    shot(page, "12-search-validation")

    search.fill(RESTRICTED)
    page.get_by_role("button", name="Search", exact=True).click()
    settle(page)
    r.expect(lambda: expect(page.get_by_text("Details hidden — restricted record")).to_be_visible(), "restricted member is listed but masked")
    shot(page, "13-search-restricted-row")

    # --- member details ----------------------------------------------------------
    search.fill(HAPPY)
    page.get_by_role("button", name="Search", exact=True).click()
    settle(page)
    page.get_by_role("link", name=HAPPY).click()
    settle(page)
    band = page.get_by_role("region", name="Member")
    r.expect(lambda: expect(band.get_by_role("heading", level=1)).to_contain_text("Cunningham"), "member band shows the member's name")
    r.expect(lambda: expect(page.get_by_role("heading", name="Identity")).to_be_visible(), "overview shows the identity panel")
    shot(page, "20-member-overview")

    page.get_by_role("button", name="Reveal").click()
    r.expect(lambda: expect(page.get_by_text(re.compile(r"9\d\d-\d\d-\d{4}"))).to_be_visible(), "SSN reveal shows the full number")
    r.expect(lambda: expect(page.get_by_role("button", name=re.compile(r"Hide \(\d+s\)"))).to_be_visible(), "reveal counts down to re-mask")
    shot(page, "21-member-ssn-revealed")
    page.get_by_role("button", name=re.compile(r"Hide")).click()

    # --- accounts ---------------------------------------------------------------
    page.get_by_role("link", name=re.compile(r"^Accounts")).click()
    settle(page)
    r.expect(lambda: expect(page.get_by_role("heading", name="Deposit accounts")).to_be_visible(), "accounts tab lists deposit accounts")
    r.expect(lambda: expect(page.get_by_text("Total deposits")).to_be_visible(), "deposit totals row is shown")
    shot(page, "22-member-accounts", full_page=True)

    page.get_by_role("link", name=f"{HAPPY}-S00").click()
    settle(page)
    r.expect(lambda: expect(page.get_by_role("heading", name="Transactions")).to_be_visible(), "account detail shows the ledger")
    r.expect(lambda: expect(page.get_by_role("columnheader", name="Balance", exact=True)).to_be_visible(), "ledger has a running balance column")
    shot(page, "23-account-detail", full_page=True)

    # jump to the last page to see the balance-forward row
    for _ in range(12):
        nxt = page.get_by_role("button", name="Next")
        if not nxt.count() or nxt.is_disabled():
            break
        nxt.click()
        settle(page, 150)
    r.expect(lambda: expect(page.get_by_text("Balance forward")).to_be_visible(), "last ledger page ends with the balance forward")
    shot(page, "24-account-ledger-last-page")

    page.get_by_label("Description or check #").fill("DIVIDEND")
    page.get_by_role("button", name="Apply").click()
    settle(page)
    r.expect(lambda: expect(page.get_by_role("table")).to_contain_text("DIVIDEND"), "ledger filter narrows by description")

    # --- notes ------------------------------------------------------------------
    page.goto(f"{BASE_URL}/members/{HAPPY}/notes")
    settle(page)
    page.get_by_role("main").get_by_role("button", name="Add note").click()
    page.get_by_role("button", name="Save note").click()
    r.expect(lambda: expect(page.get_by_text("Choose a category.")).to_be_visible(), "note form validates category")
    shot(page, "25-note-validation")
    page.get_by_label("Category").select_option("Service")
    page.get_by_label("Note", exact=True).fill("Member asked about 12-month certificate rates; quoted 4.25% APY. Will call back Friday.")
    page.get_by_role("button", name="Save note").click()
    r.expect(lambda: expect(page.get_by_text("Note added")).to_be_visible(), "saving a note confirms with a toast")
    settle(page)
    shot(page, "26-notes")

    # --- outcomes ---------------------------------------------------------------
    page.goto(f"{BASE_URL}/members/9999999")
    settle(page)
    r.expect(lambda: expect(page.get_by_role("heading", name="Member not found")).to_be_visible(), "unknown member number shows Member not found")
    shot(page, "30-member-not-found")

    page.goto(f"{BASE_URL}/members/{RESTRICTED}")
    settle(page)
    r.expect(lambda: expect(page.get_by_role("heading", name="You don't have access to this record")).to_be_visible(), "restricted record shows Permission denied")
    r.expect(lambda: expect(page.get_by_text(re.compile(r"AUD-\d{8}"))).to_be_visible(), "denial carries an audit reference")
    shot(page, "31-permission-denied-restricted")

    page.goto(f"{BASE_URL}/no-such-page")
    settle(page)
    r.expect(lambda: expect(page.get_by_role("heading", name="This page doesn't exist")).to_be_visible(), "unknown route shows a 404 page")

    # --- reference pages ----------------------------------------------------------
    page.get_by_role("link", name="Product rates").click()
    settle(page)
    r.expect(lambda: expect(page.get_by_role("heading", name="Product rates")).to_be_visible(), "product rate sheet loads")
    shot(page, "40-product-rates", full_page=True)

    page.get_by_role("link", name="My activity").first.click()
    settle(page)
    r.expect(lambda: expect(page.get_by_role("table")).to_contain_text("Revealed full SSN"), "my activity records the SSN reveal")
    shot(page, "41-my-activity")

    # --- sign out ---------------------------------------------------------------
    page.get_by_role("button", name=re.compile("Adaeze Okafor")).click()
    page.get_by_role("menuitem", name="Sign out").click()
    settle(page)
    r.expect(lambda: expect(page.get_by_text("You've signed out.")).to_be_visible(), "sign out returns to sign-in with a confirmation")


run("members", body)
