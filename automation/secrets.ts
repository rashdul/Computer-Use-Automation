import { readFile } from "node:fs/promises";

export type SecretKey = "RFCU_STAFF_USERNAME" | "RFCU_STAFF_PASSWORD";
export class Secrets {
  private constructor(
    private readonly username: string,
    private readonly password: string,
  ) {}
  static async load(
    path = "target-app/STAFF_CREDENTIALS.local.md",
    selected = process.env.RFCU_STAFF_USERNAME,
  ) {
    const text = await readFile(path, "utf8");
    const rows = text
      .split(/\r?\n/)
      .map((line) => line.match(/^\| `([^`]+)` \|.*\| `([^`]+)` \|\s*$/))
      .filter(Boolean);
    const row = selected
      ? rows.find((r) => r![1] === selected)
      : rows.find((r) => /Member Service Representative|\bmsr\b/i.test(r![0]));
    const username = row?.[1] ?? text.match(/^Username:\s*(.+)$/m)?.[1]?.trim();
    const password = row?.[2] ?? text.match(/^Password:\s*(.+)$/m)?.[1]?.trim();
    if (!username || !password || /YOUR_LOCAL_/.test(username + password))
      throw new Error(
        "Local staff credentials missing or invalid; see credential template",
      );
    return new Secrets(username, password);
  }
  get(key: SecretKey) {
    return key === "RFCU_STAFF_USERNAME" ? this.username : this.password;
  }
  redact(text: string) {
    for (const secret of [
      this.username,
      this.password,
      process.env.OPENAI_API_KEY,
    ].filter(Boolean) as string[])
      text = text.split(secret).join("[REDACTED]");
    return text.replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "[TOKEN]",
    );
  }
  assertAbsent(text: string) {
    if ([this.username, this.password].some((s) => text.includes(s)))
      throw new Error("SECRET_SERIALIZATION_BLOCKED");
  }
  toJSON() {
    return "[SECRET_PROVIDER]";
  }
}
export function parameterize(
  text: string,
  inputs: Record<string, string | undefined>,
) {
  const replace = (str: string) => {
    for (const [key, value] of Object.entries(inputs).sort(
      (a, b) => (b[1]?.length ?? 0) - (a[1]?.length ?? 0),
    )) {
      if (!value) continue;
      const placeholder = "{{" + key + "}}";
      if (str === value) {
        str = placeholder;
        continue;
      }
      if (value.length < 4) continue;
      for(const variant of [value,encodeURIComponent(value),new URLSearchParams({q:value}).toString().slice(2)]) {
        const escaped=variant.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
        str=str.replace(new RegExp("(?<![\\p{L}\\p{N}_])"+escaped+"(?![\\p{L}\\p{N}_])","gu"),()=>placeholder);
      }
    }
    return str;
  };
  try {
    const parsed = JSON.parse(text);
    const structural=new Set(["action","kind","role","type","source","key","output","outputType","currency","risk","schemaVersion","surface","profile","application","vendor"]);
    const walk = (v: any): any =>
      typeof v === "string"
        ? replace(v)
        : Array.isArray(v)
          ? v.map(walk)
          : v && typeof v === "object"
            ? Object.fromEntries(
                Object.entries(v).map(([k, value]) => [k, structural.has(k)?value:walk(value)]),
              )
            : v;
    return JSON.stringify(walk(parsed));
  } catch {
    return replace(text);
  }
}
export function redactPII(text: string) {
  return text
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[EMAIL]")
    .replace(/\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/g, "[PHONE]");
}
