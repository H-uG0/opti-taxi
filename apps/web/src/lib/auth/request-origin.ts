/**
 * Where a request comes from, as the audit trail records it (AuditEvent.ip and
 * userAgentHash). Pure: lib/audit.ts reads the request headers and passes them.
 *
 * - ip: the client address only when it can be trusted, i.e. behind the
 *   reverse proxies declared by TRUSTED_PROXY_HOPS (same rule as the sign-in
 *   throttle, rate-limit.ts); null otherwise, since the client writes
 *   X-Forwarded-For itself when nothing is in front of Next.js.
 * - userAgentHash: a 16-hex-digit sha256 prefix of the User-Agent, enough to
 *   tell two devices apart in an investigation without storing the text.
 */
import { createHash } from "node:crypto";
import { trustedClientIp } from "./rate-limit";

export type RequestOrigin = { ip: string | null; userAgentHash: string | null };

export const UNKNOWN_ORIGIN: RequestOrigin = { ip: null, userAgentHash: null };

export function userAgentHash(userAgent: string | null | undefined): string | null {
  const value = userAgent?.trim();
  if (!value) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function requestOrigin(
  headers: { forwardedFor: string | null | undefined; userAgent: string | null | undefined },
  hops: number,
): RequestOrigin {
  return { ip: trustedClientIp(headers.forwardedFor, hops), userAgentHash: userAgentHash(headers.userAgent) };
}
