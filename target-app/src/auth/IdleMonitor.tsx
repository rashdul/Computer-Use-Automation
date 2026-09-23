import { Clock3 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { api } from "../lib/api";
import { useAuth } from "./AuthContext";

const ACTIVITY_EVENTS = ["mousedown", "keydown", "wheel", "touchstart", "mousemove"] as const;

/** Signs the user out after the configured inactivity window, with a countdown warning first. */
export function IdleMonitor() {
  const { status, environment, expire, signOut } = useAuth();
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const lastActivity = useRef(Date.now());
  const warningOpen = useRef(false);
  warningOpen.current = secondsLeft !== null;

  useEffect(() => {
    let lastMove = 0;
    const onActivity = (e: Event) => {
      if (warningOpen.current) return; // only "Stay signed in" resets once warned
      if (e.type === "mousemove") {
        const now = Date.now();
        if (now - lastMove < 1000) return;
        lastMove = now;
      }
      lastActivity.current = Date.now();
    };
    ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
    return () => ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, onActivity));
  }, []);

  // Read through refs: the heartbeat replaces the environment object every 30 seconds,
  // and that must not restart the idle clock.
  const limits = useRef({ timeoutMs: 15 * 60_000, warnMs: 60_000 });
  limits.current = {
    timeoutMs: (environment?.idle_timeout_minutes ?? 15) * 60_000,
    warnMs: (environment?.idle_warning_seconds ?? 60) * 1000,
  };
  const expireRef = useRef(expire);
  expireRef.current = expire;
  const ready = status === "ready" && environment !== null;

  useEffect(() => {
    if (!ready) {
      setSecondsLeft(null);
      return;
    }
    lastActivity.current = Date.now();
    const t = window.setInterval(() => {
      const { timeoutMs, warnMs } = limits.current;
      const idle = Date.now() - lastActivity.current;
      if (idle >= timeoutMs) {
        window.clearInterval(t);
        setSecondsLeft(null);
        void expireRef.current("idle");
      } else if (idle >= timeoutMs - warnMs) {
        setSecondsLeft(Math.ceil((timeoutMs - idle) / 1000));
      } else {
        setSecondsLeft(null);
      }
    }, 500);
    return () => window.clearInterval(t);
  }, [ready]);

  const stay = () => {
    lastActivity.current = Date.now();
    setSecondsLeft(null);
    void api.heartbeat().catch(() => undefined);
  };

  const minutes = environment?.idle_timeout_minutes ?? 15;

  return (
    <Modal
      open={secondsLeft !== null}
      role="alertdialog"
      tone="warn"
      icon={<Clock3 size={17} aria-hidden="true" />}
      title="Your session is about to end"
      footer={
        <>
          <Button onClick={() => void signOut()}>Sign out now</Button>
          <Button variant="primary" onClick={stay} autoFocus>
            Stay signed in
          </Button>
        </>
      }
    >
      <p>
        There's been no activity for about {minutes} minute{minutes === 1 ? "" : "s"}. For your security, you'll be signed out in{" "}
        <strong className="num">{secondsLeft ?? 0} seconds</strong>. Unsaved work on this screen will be lost.
      </p>
    </Modal>
  );
}
