import { resolveAccess, type Access } from "./access";
import type { AuthPortGetter } from "./auth-port";
import { fakeSessionUser, isFakeAuthEnabled } from "./e2e-session";

export interface AccessDeps {
  getPort: AuthPortGetter;
  readE2eCookie: () => Promise<string | undefined>;
}

/**
 * Never throws: any failure to establish who the user is means "anonymous" (fail closed).
 */
export async function loadAccess(deps: AccessDeps): Promise<Access> {
  try {
    if (isFakeAuthEnabled()) {
      return resolveAccess(fakeSessionUser(await deps.readE2eCookie()));
    }
    const port = await deps.getPort();
    return resolveAccess(await port.getSessionUser());
  } catch {
    return { status: "anonymous" };
  }
}
