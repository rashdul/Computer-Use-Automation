"""Open Sub-Account → Review → Confirmation, with every business outcome
the flow can produce. Signs in as an MSR. Uses the scenario catalogue members."""

import re

from playwright.sync_api import Page

from support import BASE_URL, expect, run, settle, shot, sign_in, sign_out

HAPPY = "1030966"
JOINT = "1000021"
NO_EMAIL = "1000082"
LOW_BALANCE = "1000564"
OFAC = "1002123"
DECEASED = "1000222"
DORMANT = "1000204"
MINOR = "1068311"


def choose_product(page: Page, name: str) -> None:
    page.get_by_role("radio", name=re.compile(rf"^{re.escape(name)}")).check()


def select_account(page: Page, label: str, account_number: str) -> None:
    """Choose the <option> whose visible text starts with the account number."""
    select = page.get_by_label(label, exact=True)
    value = select.locator("option", has_text=account_number).first.get_attribute("value")
    select.select_option(value=value)


def fill_compliance(page: Page) -> None:
    page.get_by_label("Purpose of the account").select_option("Long-term savings")
    page.get_by_label("Expected monthly deposits").select_option("under_1000")
    page.get_by_label("Source of funds").select_option("savings")


def acknowledge_and_sign(page: Page) -> None:
    for box in page.get_by_role("group", name="The member received").get_by_role("checkbox").all():
        box.check()
    page.get_by_role("radio", name="Signed on the signature pad").check()


def body(browser, page, r):
    sign_in(page, "aokafor")

    # --- happy path ----------------------------------------------------------------
    page.goto(f"{BASE_URL}/members/{HAPPY}")
    settle(page)
    page.get_by_role("region", name="Member").get_by_role("button", name="Open sub-account").click()
    settle(page)
    r.expect(lambda: expect(page.get_by_role("heading", name="Open a sub-account")).to_be_visible(), "Open sub-account form loads")
    r.expect(lambda: expect(page.get_by_role("list", name="Progress")).to_contain_text("Details"), "stepper shows the three steps")
    shot(page, "50-open-form", full_page=True)

    page.get_by_role("button", name="Continue to review").click()
    r.expect(lambda: expect(page.get_by_text(re.compile(r"Fix \d+ problems to continue"))).to_be_visible(), "empty form shows an error summary")
    r.expect(lambda: expect(page.get_by_role("alert").get_by_role("link", name="Choose a product.")).to_be_visible(), "summary links to each field")
    shot(page, "51-open-form-errors")

    choose_product(page, "12-Month Share Certificate")
    page.get_by_role("radio", name="Transfer from another sub-account").check()
    page.get_by_label("Deposit amount").fill("750")
    select_account(page, "Transfer from", f"{HAPPY}-S00")
    page.get_by_role("radio", name="Electronic").check()
    fill_compliance(page)
    r.expect(lambda: expect(page.get_by_role("complementary", name="Application summary")).to_contain_text(f"{HAPPY}-C"), "summary previews the new account number")
    shot(page, "52-open-form-filled", full_page=True)

    page.get_by_role("button", name="Continue to review").click()
    settle(page)
    r.expect(lambda: expect(page.get_by_role("heading", name="Review and open")).to_be_visible(), "review step loads")
    shot(page, "53-review", full_page=True)

    page.get_by_role("button", name="Open account").click()
    r.expect(lambda: expect(page.get_by_text("Confirm the member received every required disclosure.")).to_be_visible(), "review requires disclosures")
    r.expect(lambda: expect(page.get_by_text("Record how the member signed.")).to_be_visible(), "review requires a signature method")
    shot(page, "54-review-errors")

    acknowledge_and_sign(page)
    page.get_by_role("button", name="Open account").click()
    page.wait_for_url(re.compile(r"/confirmation/OA\d{6}-[A-Z0-9]{6}$"), timeout=20_000)
    settle(page, 500)
    r.expect(lambda: expect(page.get_by_role("heading", name=re.compile("12-Month Share Certificate opened"))).to_be_visible(), "confirmation page shows the opened product")
    r.expect(lambda: expect(page.get_by_text(re.compile(r"OA\d{6}-[A-Z0-9]{6}")).first).to_be_visible(), "confirmation number is shown")
    r.expect(lambda: expect(page.get_by_label(re.compile(r"^Opened .* Eastern at BAL-MSR-04"))).to_be_visible(), "receipt carries the teller stamp")
    shot(page, "55-confirmation", full_page=True)

    confirmation_url = page.url
    page.reload()
    settle(page)
    r.expect(lambda: expect(page.get_by_role("heading", name="12-Month Share Certificate opened")).to_be_visible(), "confirmation survives a reload")

    page.get_by_role("link", name="View account").click()
    settle(page)
    r.expect(lambda: expect(page.get_by_role("table")).to_contain_text("Opening deposit · transfer from"), "new account ledger shows the opening transfer")
    shot(page, "56-new-account-detail", full_page=True)

    # --- duplicate product confirmation -------------------------------------------
    page.goto(f"{BASE_URL}/members/{HAPPY}/accounts/new")
    settle(page)
    choose_product(page, "12-Month Share Certificate")
    page.get_by_role("radio", name="Transfer from another sub-account").check()
    page.get_by_label("Deposit amount").fill("600")
    select_account(page, "Transfer from", f"{HAPPY}-S00")
    page.get_by_role("radio", name="Electronic").check()
    fill_compliance(page)
    page.get_by_role("button", name="Continue to review").click()
    settle(page)
    acknowledge_and_sign(page)
    page.get_by_role("button", name="Open account").click()
    dialog = page.get_by_role("dialog", name=re.compile("Member already has a 12-Month Share Certificate"))
    r.expect(lambda: expect(dialog).to_be_visible(), "second certificate asks for confirmation")
    shot(page, "57-duplicate-dialog")
    dialog.get_by_role("button", name="Cancel").click()
    r.expect(lambda: expect(dialog).to_be_hidden(), "cancelling the duplicate keeps the member on review")

    # --- unsaved changes guard --------------------------------------------------------
    page.goto(f"{BASE_URL}/members/{HAPPY}/accounts/new")
    settle(page)
    choose_product(page, "Holiday Club")
    page.get_by_role("link", name="Product rates").click()
    leave = page.get_by_role("dialog", name="Leave this application?")
    r.expect(lambda: expect(leave).to_be_visible(), "navigating away from a started form asks to confirm")
    page.wait_for_timeout(300)  # let the modal finish fading in
    shot(page, "58-leave-dialog")
    leave.get_by_role("button", name="Keep editing").click()
    r.expect(lambda: expect(page).to_have_url(re.compile(r"/accounts/new$")), "Keep editing stays on the form")
    page.get_by_role("link", name="Product rates").click()
    leave.get_by_role("button", name="Discard application").click()
    r.expect(lambda: expect(page.get_by_role("heading", name="Product rates")).to_be_visible(), "Discard leaves the form")

    # --- client + server validation rules -------------------------------------------
    page.goto(f"{BASE_URL}/members/{NO_EMAIL}/accounts/new")
    settle(page)
    choose_product(page, "Regular Share Savings")
    page.get_by_role("radio", name="No opening deposit").check()
    page.get_by_role("radio", name="Electronic").check()
    fill_compliance(page)
    page.get_by_role("button", name="Continue to review").click()
    r.expect(lambda: expect(page.get_by_text("No email address on file.", exact=False).first).to_be_visible(), "electronic statements need an email on file")
    shot(page, "60-validation-no-email")

    page.goto(f"{BASE_URL}/members/{LOW_BALANCE}/accounts/new")
    settle(page)
    choose_product(page, "6-Month Share Certificate")
    page.get_by_role("radio", name="Transfer from another sub-account").check()
    page.get_by_label("Deposit amount").fill("500")
    select_account(page, "Transfer from", f"{LOW_BALANCE}-S00")
    page.get_by_role("radio", name="Paper").check()
    fill_compliance(page)
    page.get_by_role("button", name="Continue to review").click()
    r.expect(lambda: expect(page.get_by_text(re.compile(r"Available balance in \d{7}-S00 is|must keep its \$5\.00 minimum")).first).to_be_visible(), "transfer larger than the balance is refused")
    shot(page, "61-validation-insufficient-funds")

    # --- members who can't open accounts -------------------------------------------------
    for number, label, shotname, expected in [
        (OFAC, "OFAC review", "62-blocked-ofac", "OFAC screening match is under review"),
        (DECEASED, "deceased", "63-blocked-deceased", "Member is deceased"),
        (DORMANT, "dormant", "64-blocked-dormant", "Membership is dormant"),
    ]:
        page.goto(f"{BASE_URL}/members/{number}/accounts/new")
        settle(page)
        r.expect(lambda: expect(page.get_by_role("heading", name="New sub-accounts can't be opened for this member")).to_be_visible(), f"{label} member is blocked from opening")
        r.expect(lambda: expect(page.get_by_text(expected, exact=False)).to_be_visible(), f"{label} block explains why")
        shot(page, shotname)

    page.goto(f"{BASE_URL}/members/{MINOR}/accounts/new")
    settle(page)
    r.expect(lambda: expect(page.get_by_role("radio", name=re.compile(r"^12-Month Share Certificate"))).to_be_disabled(), "minor can't choose a certificate")
    r.expect(lambda: expect(page.get_by_text("Not available: Member must be 18 or older").first).to_be_visible(), "ineligible products say why")
    shot(page, "65-minor-products", full_page=True)

    # --- joint ownership ------------------------------------------------------------------
    page.goto(f"{BASE_URL}/members/{JOINT}/accounts/new")
    settle(page)
    choose_product(page, "Regular Share Savings")
    page.get_by_role("radio", name="Joint with another member").check()
    spouse = page.get_by_role("group", name="Joint owners").get_by_role("checkbox").first
    spouse.check()
    page.get_by_role("radio", name="Cash").check()
    page.get_by_label("Deposit amount").fill("100")
    page.get_by_role("radio", name="Paper").check()
    fill_compliance(page)
    shot(page, "66-joint-form", full_page=True)
    page.get_by_role("button", name="Continue to review").click()
    settle(page)
    acknowledge_and_sign(page)
    page.get_by_role("button", name="Open account").click()
    page.wait_for_url(re.compile(r"/confirmation/"), timeout=20_000)
    settle(page, 400)
    r.expect(lambda: expect(page.get_by_text("Joint owners", exact=True)).to_be_visible(), "joint opening shows joint owners on the receipt")
    r.expect(lambda: expect(page.get_by_text("Joint owners sign the signature card", exact=False)).to_be_visible(), "next steps remind about the joint signature card")
    shot(page, "67-joint-confirmation", full_page=True)
    print("   confirmation:", confirmation_url.rsplit("/", 1)[-1])
    sign_out(page)


run("opening", body)
