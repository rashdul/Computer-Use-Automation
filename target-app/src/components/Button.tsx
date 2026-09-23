import clsx from "clsx";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link, type LinkProps } from "react-router";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost" | "on-ink" | "on-ink-primary";
type Size = "sm" | "md" | "lg";

interface Common {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  iconAfter?: ReactNode;
  block?: boolean;
}

interface ButtonProps extends Common, ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  loadingText?: string;
}

function classes(variant: Variant, size: Size, block?: boolean, iconOnly?: boolean, extra?: string) {
  return clsx("btn", `btn--${variant}`, size !== "md" && `btn--${size}`, block && "btn--block", iconOnly && "btn--icon", extra);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, iconAfter, block, loading, loadingText, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={classes(variant, size, block, !children && !!icon, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : icon}
      {loading && loadingText ? loadingText : children}
      {!loading && iconAfter}
    </button>
  );
});

interface ButtonLinkProps extends Common, LinkProps {}

export function ButtonLink({ variant = "secondary", size = "md", icon, iconAfter, block, className, children, ...rest }: ButtonLinkProps) {
  return (
    <Link className={classes(variant, size, block, !children && !!icon, className)} style={{ textDecoration: "none" }} {...rest}>
      {icon}
      {children}
      {iconAfter}
    </Link>
  );
}
