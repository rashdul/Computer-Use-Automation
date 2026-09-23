export class RuntimeCondition extends Error {
  constructor(
    public code: string,
    message: string,
    public category: "business" | "recoverable" | "hard" = "hard",
    public expected?: unknown,
    public observed?: unknown,
  ) {
    super(message);
  }
}
export function classifyText(text: string): RuntimeCondition | undefined {
  if (/No members match|Member not found/i.test(text))
    return new RuntimeCondition(
      "MEMBER_NOT_FOUND",
      "No member matches the requested ID",
      "business",
    );
  if (
    /Permission denied|You don.t have permission|staff account is disabled/i.test(
      text,
    )
  )
    return new RuntimeCondition(
      "PERMISSION_DENIED",
      "The staff session cannot access this record",
    );
  if (
    /username or password|incorrect password|invalid login|sign-in failed|staff profile couldn.t be loaded/i.test(
      text,
    )
  )
    return new RuntimeCondition(
      "AUTHENTICATION_REJECTED",
      "Staff authentication was rejected",
    );
  if (/Enter your username|Enter your password/i.test(text))
    return new RuntimeCondition(
      "LOGIN_VALIDATION_FAILED",
      "Login form validation failed",
    );
  if (/request timed out|service unavailable/i.test(text))
    return new RuntimeCondition(
      "TRANSIENT_APPLICATION_ERROR",
      "The application reported a transient failure",
      "recoverable",
    );
}
