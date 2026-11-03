import type { Prisma } from "@prisma/client";

/**
 * Spread into a user update (`update` or `updateMany`) to end every open
 * session of the account, on every device: tokens carry the session version
 * they were opened with (claim "sv"), and sessionIsCurrent (session-check.ts)
 * refuses any other. Use it on logout, on deactivating the account or its
 * driver, and on setting a new password or e-mail. The bump is permanent:
 * reactivating the account does not bring the old sessions back.
 */
export const REVOKE_SESSIONS = { sessionVersion: { increment: 1 } } as const satisfies Prisma.UserUpdateManyMutationInput;
