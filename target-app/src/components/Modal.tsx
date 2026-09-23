import clsx from "clsx";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  open: boolean;
  /** Omit to make the dialog non-dismissable (no Escape, no backdrop click). */
  onClose?: () => void;
  title: ReactNode;
  icon?: ReactNode;
  tone?: "info" | "warn" | "bad";
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  role?: "dialog" | "alertdialog";
  plainBody?: boolean;
}

const EXIT_MS = 150;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, icon, tone = "info", children, footer, wide, role = "dialog", plainBody }: ModalProps) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement as HTMLElement | null;
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const t = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
      restoreRef.current?.focus?.();
    }, EXIT_MS);
    return () => window.clearTimeout(t);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // initial focus: an element with autoFocus wins, else the first control
  useEffect(() => {
    if (!mounted || closing) return;
    const node = dialogRef.current;
    if (!node) return;
    const t = window.setTimeout(() => {
      if (node.contains(document.activeElement)) return;
      const first = node.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? node).focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [mounted, closing]);

  if (!mounted) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && onClose) {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="overlay"
      data-closing={closing || undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={clsx("modal", wide && "modal--wide")}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={children ? bodyId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal__header">
          {icon && <div className={clsx("modal__icon", tone !== "info" && `modal__icon--${tone}`)}>{icon}</div>}
          <h2 className="modal__title" id={titleId}>
            {title}
          </h2>
        </div>
        {children && (
          <div className={clsx("modal__body", (plainBody || !icon) && "modal__body--plain")} id={bodyId}>
            {children}
          </div>
        )}
        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
