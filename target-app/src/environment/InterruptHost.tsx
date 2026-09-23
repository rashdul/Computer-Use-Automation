import { CalendarClock, CheckCheck, MonitorSmartphone, Printer, ShieldCheck, KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { JUST_SIGNED_IN_KEY, useAuth } from "../auth/AuthContext";
import { Button } from "../components/Button";
import { Check } from "../components/form";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import type { InterruptKind, InterruptTrigger } from "../lib/types";

/** Maps a route to the trigger point administrators can target. */
function triggerFor(pathname: string): InterruptTrigger | null {
  if (/^\/members\/?$/.test(pathname)) return "member_search";
  if (/^\/members\/\d{7}\/accounts\/new\/review\/?$/.test(pathname)) return "review";
  if (/^\/members\/\d{7}\/accounts\/new\/?$/.test(pathname)) return "open_sub_account";
  if (/^\/members\/\d{7}\/accounts(\/.*)?$/.test(pathname)) return "accounts";
  if (/^\/members\/\d{7}\/?$/.test(pathname)) return "member_details";
  return null;
}

const SHOWN_KEY = "rfcu.console.interrupts-shown";

function shownTriggers(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(SHOWN_KEY) ?? "[]");
  } catch {
    return [];
  }
}

/**
 * UAT "unexpected dialog" injector. Administration → Environment controls
 * decides whether, where, how often, and which interstitials appear.
 */
export function InterruptHost() {
  const { status, environment, context } = useAuth();
  const location = useLocation();
  const [kind, setKind] = useState<InterruptKind | null>(null);
  const openRef = useRef(false);
  openRef.current = kind !== null;

  useEffect(() => {
    if (status !== "ready" || !environment || !environment.interrupts_enabled) return;
    if (openRef.current) return;
    const path = location.pathname;
    if (path.startsWith("/admin")) return;

    const justSignedIn = sessionStorage.getItem(JUST_SIGNED_IN_KEY) === "1";
    if (justSignedIn) sessionStorage.removeItem(JUST_SIGNED_IN_KEY);

    const here = triggerFor(path);
    const trigger = environment.interrupt_trigger;
    const matches =
      trigger === "random" ? here !== null || justSignedIn : trigger === "sign_in" ? justSignedIn : trigger === here;
    if (!matches) return;

    if (environment.interrupt_once_per_session && shownTriggers().includes(trigger)) return;
    if (Math.random() * 100 >= environment.interrupt_probability_pct) return;
    const kinds = environment.interrupt_kinds;
    if (!kinds.length) return;
    const pick = kinds[Math.floor(Math.random() * kinds.length)];

    const t = window.setTimeout(() => {
      if (openRef.current) return;
      sessionStorage.setItem(SHOWN_KEY, JSON.stringify([...new Set([...shownTriggers(), trigger])]));
      setKind(pick);
    }, environment.interrupt_delay_ms);
    return () => window.clearTimeout(t);
  }, [location.pathname, status, environment]);

  if (!kind || !context) return null;
  return <InterruptDialog kind={kind} workstation={context.staff.workstation} onDone={() => setKind(null)} />;
}

function InterruptDialog({ kind, workstation, onDone }: { kind: InterruptKind; workstation: string; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState<"start" | "attest" | "retrying" | "offline">("start");
  const [attested, setAttested] = useState(false);

  const close = (after?: () => void) => {
    setOpen(false);
    window.setTimeout(() => {
      onDone();
      after?.();
    }, 160);
  };

  switch (kind) {
    case "maintenance_notice":
      return (
        <Modal
          open={open}
          role="alertdialog"
          icon={<CalendarClock size={17} aria-hidden="true" />}
          title="Scheduled maintenance tonight"
          footer={
            <Button variant="primary" autoFocus onClick={() => close()}>
              Acknowledge
            </Button>
          }
        >
          <p>
            Core processing will be unavailable <strong>Saturday, Sep 26 from 11:00 PM to 2:00 AM ET</strong>. Finish pending account
            work before then. Teller drawers must be balanced by 10:30 PM.
          </p>
          <p className="modal__meta">Notice IT-CHG-20417 · Posted by Enterprise Systems</p>
        </Modal>
      );

    case "compliance_attestation":
      return (
        <Modal
          open={open}
          role="alertdialog"
          tone="warn"
          icon={<ShieldCheck size={17} aria-hidden="true" />}
          title={step === "attest" ? "Confirm your BSA/AML attestation" : "Annual BSA/AML attestation due"}
          footer={
            step === "attest" ? (
              <>
                <Button onClick={() => setStep("start")}>Back</Button>
                <Button
                  variant="primary"
                  disabled={!attested}
                  onClick={() => close(() => toast.show({ title: "Attestation recorded", text: "Thanks — Compliance has your 2026 attestation." }))}
                >
                  Submit attestation
                </Button>
              </>
            ) : (
              <>
                <Button onClick={() => close()}>Remind me later</Button>
                <Button variant="primary" autoFocus onClick={() => setStep("attest")}>
                  Attest now
                </Button>
              </>
            )
          }
        >
          {step === "attest" ? (
            <Check
              label="I completed Bank Secrecy Act / Anti-Money Laundering Training 2026 and understand my reporting obligations."
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
            />
          ) : (
            <p>
              Your annual Bank Secrecy Act training attestation is due <strong>September 30</strong>. You'll be reminded at each sign-in
              until it's done.
            </p>
          )}
        </Modal>
      );

    case "password_expiry":
      return (
        <Modal
          open={open}
          role="alertdialog"
          tone="warn"
          icon={<KeyRound size={17} aria-hidden="true" />}
          title="Your password expires in 3 days"
          footer={
            <Button variant="primary" autoFocus onClick={() => close()}>
              OK, got it
            </Button>
          }
        >
          <p>
            Change it from Windows (<span className="mono">Ctrl+Alt+Del</span> → Change a password) before Friday to avoid being locked out
            of the console.
          </p>
        </Modal>
      );

    case "printer_offline":
      return (
        <Modal
          open={open}
          role="alertdialog"
          tone="bad"
          icon={<Printer size={17} aria-hidden="true" />}
          title="Receipt printer not responding"
          footer={
            step === "offline" ? (
              <Button variant="primary" autoFocus onClick={() => close()}>
                Dismiss
              </Button>
            ) : (
              <>
                <Button onClick={() => close()} disabled={step === "retrying"}>
                  Dismiss
                </Button>
                <Button
                  variant="primary"
                  autoFocus
                  loading={step === "retrying"}
                  loadingText="Checking printer…"
                  onClick={() => {
                    setStep("retrying");
                    window.setTimeout(() => setStep("offline"), 1400);
                  }}
                >
                  Retry connection
                </Button>
              </>
            )
          }
        >
          {step === "offline" ? (
            <p>
              Still offline. IT has been notified (ticket <span className="mono">INC-48213</span>). Receipts will queue and print when the
              printer reconnects.
            </p>
          ) : (
            <p>
              The EPSON TM-T88VI at <span className="mono">{workstation}</span> didn't respond. Receipts will print when it reconnects.
            </p>
          )}
        </Modal>
      );

    case "duplicate_session":
      return (
        <Modal
          open={open}
          role="alertdialog"
          tone="warn"
          icon={<MonitorSmartphone size={17} aria-hidden="true" />}
          title="Signed in on another workstation"
          footer={
            <>
              <Button
                variant="danger-ghost"
                onClick={() =>
                  close(() => toast.show({ tone: "info", title: "Reported to the Help Desk", text: "Security will call your extension shortly." }))
                }
              >
                Report to Help Desk
              </Button>
              <Button variant="primary" autoFocus icon={<CheckCheck size={14} aria-hidden="true" />} onClick={() => close()}>
                This was me
              </Button>
            </>
          }
        >
          <p>
            Your user ID is also signed in at <span className="mono">TWS-TLR-02</span> (Towson). If that wasn't you, report it to the Help
            Desk now.
          </p>
        </Modal>
      );
  }
}
