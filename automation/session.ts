import type { SessionState } from "./schema.js";
import { RuntimeCondition } from "./errors.js";
export class SessionManager {
  state: SessionState = "unauthenticated";
  everAuthenticated = false;
  observe(path: string, authenticatedShell: boolean) {
    if (
      path === "/session-expired" ||
      (this.everAuthenticated && path === "/login")
    ) {
      this.state = "expired";
      throw new RuntimeCondition(
        "SESSION_EXPIRED",
        "Session ended or redirected to login; automatic continuation is disabled",
      );
    }
    if (authenticatedShell && path.startsWith("/members")) {
      this.state = "authenticated";
      this.everAuthenticated = true;
    }
    return this.state;
  }
  authenticating() {
    if (!this.everAuthenticated) this.state = "authenticating";
  }
  block() {
    this.state = "blocked";
  }
}
