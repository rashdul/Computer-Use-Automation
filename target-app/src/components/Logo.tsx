/**
 * Rashed Federal Credit Union mark: a slab-serif R standing on a brass plinth
 * rule — the foundation stone of a bank building, drawn at icon scale.
 */
interface MarkProps {
  size?: number;
  tone?: "light" | "dark";
  title?: string;
}

export function Mark({ size = 30, tone = "light", title }: MarkProps) {
  const onDark = tone === "dark";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="5"
        fill={onDark ? "#12305a" : "#0f2744"}
        stroke={onDark ? "rgba(201,164,92,0.55)" : "#0f2744"}
      />
      <path
        fill="#ffffff"
        fillRule="evenodd"
        d="M7 7H18.6C21.9 7 24.2 9.1 24.2 12.2C24.2 14.7 22.7 16.6 20.2 17.2L23.8 23H25.6V25H20.6L15.9 17.4H13V23H15V25H7V23H9V9H7ZM13 9.9V14.8H18.2C19.7 14.8 20.6 13.8 20.6 12.35C20.6 10.9 19.7 9.9 18.2 9.9Z"
      />
      <rect x="7" y="26.9" width="18.6" height="1.3" rx="0.4" fill="#c9a45c" />
    </svg>
  );
}

interface LogoProps {
  tone?: "light" | "dark";
  size?: number;
}

export function Logo({ tone = "dark", size = 30 }: LogoProps) {
  const onDark = tone === "dark";
  return (
    <span className="logo" style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <Mark size={size} tone={tone} />
      <span className="wordmark" style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}>
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: size * 0.6,
            letterSpacing: "0.01em",
            color: onDark ? "#ffffff" : "var(--ink-900)",
          }}
        >
          Rashed
        </span>
        <span
          style={{
            marginTop: size * 0.12,
            fontSize: Math.max(8, size * 0.27),
            fontWeight: 650,
            letterSpacing: "0.16em",
            color: onDark ? "#8193ab" : "var(--gray-500)",
            whiteSpace: "nowrap",
          }}
        >
          FEDERAL CREDIT UNION
        </span>
      </span>
    </span>
  );
}
