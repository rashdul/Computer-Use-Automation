import clsx from "clsx";
import { CircleAlert } from "lucide-react";
import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  className?: string;
  /** The control; receives id, aria-invalid and aria-describedby. */
  children: ReactElement<{ id?: string; "aria-invalid"?: boolean; "aria-describedby"?: string }>;
}

/** Label + control + hint/error, wired together for assistive technology. */
export function Field({ label, hint, error, optional, className, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, { id, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy })
    : children;
  return (
    <div className={clsx("field", className)}>
      <label className="field__label" htmlFor={id}>
        {label}
        {optional && <span className="field__optional">(optional)</span>}
      </label>
      {control}
      {error ? (
        <span className="field__error" id={errorId}>
          <CircleAlert size={13} aria-hidden="true" />
          {error}
        </span>
      ) : (
        hint && (
          <span className="field__hint" id={hintId}>
            {hint}
          </span>
        )
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input(
  { className, mono, ...rest },
  ref,
) {
  return <input ref={ref} className={clsx("input", mono && "input--mono", className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={clsx("select", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={clsx("textarea", className)} {...rest} />;
});

interface CheckProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  hint?: ReactNode;
  type?: "checkbox" | "radio";
}

export function Check({ label, hint, type = "checkbox", className, ...rest }: CheckProps) {
  return (
    <label className={clsx("check", className)}>
      <input type={type} {...rest} />
      <span className="check__text">
        <span>{label}</span>
        {hint && <span className="check__hint">{hint}</span>}
      </span>
    </label>
  );
}

interface SegmentedProps<T extends string> {
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}

/** Radio group styled as a segmented control; still a native radio group. */
export function Segmented<T extends string>({ name, value, options, onChange, label }: SegmentedProps<T>) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className="segmented__option">
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

interface MoneyInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
}

/** Dollar amount entry: digits and one decimal point, formatted on blur. */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput({ value, onChange, onBlur, ...rest }, ref) {
  return (
    <div className="input-affix input-affix--pre">
      <span className="input-affix__pre" aria-hidden="true">
        $
      </span>
      <input
        ref={ref}
        className="input num"
        style={{ textAlign: "right" }}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ""))}
        onBlur={(e) => {
          const n = Number(value.replace(/,/g, ""));
          if (value.trim() !== "" && Number.isFinite(n)) {
            onChange(n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
          }
          onBlur?.(e);
        }}
        {...rest}
      />
    </div>
  );
});
