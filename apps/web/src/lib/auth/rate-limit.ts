/**
 * Sign-in throttling core: sliding-window attempt counters kept in memory, the
 * gate of one sign-in attempt, and the client address they are keyed on. Pure
 * (no Next.js import, injectable clock) so it is unit-tested; login-throttle.ts
 * only reads the request header and writes the log.
 *
 * Limits of an in-memory store: counters live in one Node.js process and are
 * lost on restart. Several instances (or a cluster) need a shared store
 * (PostgreSQL or Redis) instead.
 *
 * Production complement on the HDS host: nginx `limit_req` on EVERY POST to the
 * app, not on POST /login alone. A Server Action is not chosen by the URL: the
 * login action answers a POST to any page path, either through the Next-Action
 * header (Next.js forwards an action ID to whichever page holds it,
 * action-handler.js selectWorkerForForwarding) or, without that header,
 * through a multipart form body carrying the action ID (no-JavaScript form
 * submission, decodeAction). nginx cannot tell the login action from the
 * others either (action IDs change with every build), so its rate must leave
 * room for normal planning work and only caps floods, e.g.
 *   map $request_method $post_client { POST $binary_remote_addr; default ""; }
 *   limit_req_zone $post_client zone=posts:10m rate=5r/s;
 *   location / { limit_req zone=posts burst=30 nodelay; ... }
 * (nginx does not count requests whose key is empty, here every non-POST).
 * The per-e-mail and per-address limits below stay what bounds bcrypt.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";

export type LimitRule = {
  /** Attempts counted within `windowMs`; the one that reaches it starts a block. */
  limit: number;
  windowMs: number;
  /** How long a key is refused once it reached the limit. */
  blockMs: number;
};

const MINUTE = 60_000;

/**
 * Per normalized e-mail: 5 failed sign-ins within 15 min block that e-mail
 * for 15 min, whether the account exists or not (the answer must not reveal
 * which e-mails exist). A successful sign-in clears the count.
 * Accepted downside (README, « Connexion »): whoever knows an account's e-mail
 * can keep its sign-in blocked, 15 min at a time; restarting the web server
 * (in-memory counters) also lifts the block.
 */
export const EMAIL_RULE: LimitRule = { limit: 5, windowMs: 15 * MINUTE, blockMs: 15 * MINUTE };

/**
 * Per client address: 30 attempts within 5 min, successful or not, then 5 min
 * of refusals. Bounds the bcrypt work one client can cause and password
 * spraying over many e-mails.
 */
export const ADDRESS_RULE: LimitRule = { limit: 30, windowMs: 5 * MINUTE, blockMs: 5 * MINUTE };

/**
 * The bucket every request shares when its address cannot be trusted
 * (UNKNOWN_CLIENT, see clientAddress): 120 attempts within 5 min, then 5 min
 * of refusals. Higher than ADDRESS_RULE because it holds every client at once
 * (a morning shift of drivers signing in together must not trip it), yet it
 * still bounds the bcrypt work of a flood (about 12 s of CPU per 5 min at the
 * cost in password.ts). Anyone can still exhaust it and delay everyone's
 * sign-in, which is why production must set TRUSTED_PROXY_HOPS (the server
 * warns at startup, see proxyHopsWarning).
 */
export const SHARED_ADDRESS_RULE: LimitRule = { limit: 120, windowMs: 5 * MINUTE, blockMs: 5 * MINUTE };

/**
 * Keys kept per limiter. E-mail keys are 64-character digests (emailKey) and
 * address keys at most 45 characters, so a few MB per limiter at the cap
 * (measured: about 4 MB for e-mails, 6 MB for addresses), whatever is sent.
 */
export const DEFAULT_MAX_KEYS = 10_000;

type Entry = { hits: number[]; blockedUntil: number };

export type LimiterOptions = {
  /** Milliseconds since the epoch; Date.now by default (tests inject a fake clock). */
  now?: () => number;
  /** Upper bound on the number of keys tracked (see evict). */
  maxKeys?: number;
};

export class AttemptLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(
    private readonly rule: LimitRule,
    options: LimiterOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /** Milliseconds before `key` may try again; 0 when it may try now. */
  retryAfterMs(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    return Math.max(0, entry.blockedUntil - this.now());
  }

  /**
   * Counts one attempt of `key`. The attempt that brings the count within the
   * window to `limit` blocks the key for `blockMs`; the count then restarts.
   */
  hit(key: string): void {
    const now = this.now();
    const entry = this.entries.get(key) ?? { hits: [], blockedUntil: 0 };
    entry.hits = entry.hits.filter((at) => now - at < this.rule.windowMs);
    entry.hits.push(now);
    if (entry.hits.length >= this.rule.limit) {
      entry.blockedUntil = now + this.rule.blockMs;
      entry.hits = [];
    }
    // Re-inserted last: the map iterates from the least recently hit key.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evict(now);
  }

  /** Forgets `key` (a successful sign-in clears its e-mail's failures). */
  clear(key: string): void {
    this.entries.delete(key);
  }

  /** Number of keys tracked. */
  get size(): number {
    return this.entries.size;
  }

  private isLive(entry: Entry, now: number): boolean {
    return entry.blockedUntil > now || entry.hits.some((at) => now - at < this.rule.windowMs);
  }

  /**
   * Keeps at most `maxKeys` keys: first drops the expired ones (no attempt in
   * the window, no block), then the least recently hit. Someone able to create
   * that many keys can thus flush an older block; the per-address limit makes
   * that slow from one client, and nginx limit_req caps it in production.
   */
  private evict(now: number): void {
    if (this.entries.size <= this.maxKeys) return;
    for (const [key, entry] of this.entries) {
      if (!this.isLive(entry, now)) this.entries.delete(key);
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxKeys) break;
      this.entries.delete(key);
    }
  }
}

/** Whole minutes to show for a wait, at least 1. */
export function retryMinutes(waitMs: number): number {
  return Math.max(1, Math.ceil(waitMs / MINUTE));
}

// ---------------------------------------------------------------- client address

/** Shared bucket of every request whose address cannot be trusted. */
export const UNKNOWN_CLIENT = "unknown";

/**
 * Number of reverse proxies in front of Next.js that append the peer address
 * to X-Forwarded-For (TRUSTED_PROXY_HOPS, see .env.example). 0 when unset or
 * invalid.
 */
export function trustedProxyHops(raw: string | undefined): number {
  const hops = Number(raw?.trim() || "0");
  return Number.isInteger(hops) && hops >= 0 && hops <= 10 ? hops : 0;
}

/**
 * The client address to throttle on, from the X-Forwarded-For header a server
 * action sees.
 *
 * What Next.js 16 puts there (node_modules/next/dist/server/base-server.js,
 * handleRequestImpl): `req.headers['x-forwarded-for'] ??= socket.remoteAddress`.
 * So under `next start` the header is the TCP peer address only when the
 * request carried none: a client that sends its own X-Forwarded-For keeps it
 * as is. With nothing in front of Next.js, the header is therefore under the
 * client's control and cannot key a limit.
 *
 * Behind reverse proxies that each append their peer address (nginx:
 * `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`), the last
 * `hops` entries were written by those proxies: the entry `hops` places from
 * the right is the address the outermost proxy saw, which the client cannot
 * forge. Entries further left come from the client and are ignored. This
 * holds only if the Next.js port is reachable through the proxies alone
 * (`next start -H 127.0.0.1`, or a firewall).
 *
 * Hence: with `hops` = 0 (the default) every request shares UNKNOWN_CLIENT, so
 * the address limit becomes a global one (SHARED_ADDRESS_RULE; the per-e-mail
 * limit still applies per e-mail). That is fine in development; production
 * sets TRUSTED_PROXY_HOPS=1 behind nginx (proxyHopsWarning otherwise). A
 * missing or malformed entry also falls back to UNKNOWN_CLIENT.
 */
export function clientAddress(forwardedFor: string | null | undefined, hops: number): string {
  if (hops < 1 || !forwardedFor) return UNKNOWN_CLIENT;
  const entries = forwardedFor.split(",");
  const entry = entries.length >= hops ? entries[entries.length - hops] : undefined;
  return (entry !== undefined && addressBucket(entry)) || UNKNOWN_CLIENT;
}

/**
 * Throttling key of an IP address, or null when `raw` is not one: an IPv4
 * address as is (also when IPv4-mapped, "::ffff:192.0.2.1"), an IPv6 address
 * as its /64 network, since one subscriber or host usually holds a whole /64.
 */
export function addressBucket(raw: string): string | null {
  const address = raw.trim().replace(/%.*$/, "");
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined && isIP(mapped) === 4) return mapped;
  // Expand "::" to zero groups; an embedded IPv4 tail ("…:192.0.2.1") counts for two.
  const split = address.indexOf("::");
  const groupsOf = (part: string) => (part === "" ? [] : part.split(":"));
  const head = groupsOf(split === -1 ? address : address.slice(0, split));
  const tail = split === -1 ? [] : groupsOf(address.slice(split + 2));
  const tailLength = tail.reduce((sum, group) => sum + (group.includes(".") ? 2 : 1), 0);
  const zeros = split === -1 ? 0 : Math.max(0, 8 - head.length - tailLength);
  const groups = [...head, ...Array<string>(zeros).fill("0"), ...tail];
  const prefix = groups.slice(0, 4).map((group) => (group.includes(".") ? "0" : Number.parseInt(group, 16).toString(16)));
  return `${prefix.join(":")}::/64`;
}

/**
 * Startup warning about TRUSTED_PROXY_HOPS, or null (src/instrumentation.ts
 * logs it). Production always runs behind nginx (TLS), so hops = 0 there means
 * the setting was forgotten: every client then shares SHARED_ADDRESS_RULE.
 * A value that is not an integer from 0 to 10 is ignored (read as 0) in any
 * environment. The message never echoes the value.
 */
export function proxyHopsWarning(raw: string | undefined, nodeEnv: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (value !== "" && Number(value) !== 0 && trustedProxyHops(value) === 0) {
    return "TRUSTED_PROXY_HOPS must be an integer from 0 to 10: ignored, read as 0 (see .env.example).";
  }
  if (nodeEnv === "production" && trustedProxyHops(value) === 0) {
    return (
      "TRUSTED_PROXY_HOPS is 0: X-Forwarded-For is not trusted, so sign-in throttling puts every client in one " +
      "shared bucket and anyone can delay everyone's sign-in. Behind nginx set TRUSTED_PROXY_HOPS=1 (see .env.example)."
    );
  }
  return null;
}

// ---------------------------------------------------------------- login gate

/** The limiters of the login action (one set per Node.js process, see login-throttle.ts). */
export type LoginLimiters = {
  /** Failures per normalized e-mail (EMAIL_RULE). */
  email: AttemptLimiter;
  /** Attempts per trusted client address (ADDRESS_RULE). */
  address: AttemptLimiter;
  /** Attempts of every request without a trusted address, under the one key UNKNOWN_CLIENT (SHARED_ADDRESS_RULE). */
  shared: AttemptLimiter;
};

export function createLoginLimiters(options: LimiterOptions = {}): LoginLimiters {
  return {
    email: new AttemptLimiter(EMAIL_RULE, options),
    address: new AttemptLimiter(ADDRESS_RULE, options),
    shared: new AttemptLimiter(SHARED_ADDRESS_RULE, options),
  };
}

export type LoginRefusal = {
  /** The rule with the longer wait (for the log only: the user sees the same text either way). */
  by: "address" | "email";
  retryInMin: number;
};

/**
 * Gate of one sign-in attempt for `email` (already trimmed and lower-cased)
 * from `address` (clientAddress). The login action calls it before the account
 * lookup and bcrypt, so a refusal costs neither and reads the same for known
 * and unknown e-mails (the e-mail counts do not depend on the account).
 *
 * - Refused when the address or the e-mail is blocked; the wait shown is the
 *   longer of the two, so retrying after it is not refused again by the other.
 * - A refused attempt is not counted: a refusal never extends a block.
 * - An allowed attempt is counted at once against the address and, as a
 *   failure until clearLoginFailures() after a successful sign-in, against the
 *   e-mail: parallel requests cannot slip past the limit while bcrypt runs.
 */
export function gateLoginAttempt(limiters: LoginLimiters, email: string, address: string): LoginRefusal | null {
  const addressLimiter = address === UNKNOWN_CLIENT ? limiters.shared : limiters.address;
  const key = emailKey(email);
  const addressWait = addressLimiter.retryAfterMs(address);
  const emailWait = limiters.email.retryAfterMs(key);
  if (addressWait > 0 || emailWait > 0) {
    return {
      by: addressWait >= emailWait ? "address" : "email",
      retryInMin: retryMinutes(Math.max(addressWait, emailWait)),
    };
  }
  addressLimiter.hit(address);
  limiters.email.hit(key);
  return null;
}

/** A successful sign-in clears the failures counted for `email` (not the address count). */
export function clearLoginFailures(limiters: LoginLimiters, email: string): void {
  limiters.email.clear(emailKey(email));
}

/**
 * Key of an e-mail in the e-mail limiter: a fixed-size digest, so the memory
 * a key takes never depends on what a client sends (the login action also
 * bounds the e-mail, see loginSchema).
 */
export function emailKey(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}

/** Pseudonymous tag of an e-mail for the logs (sha256 prefix): never the e-mail itself. */
export function emailTag(email: string): string {
  return createHash("sha256").update(email).digest("hex").slice(0, 12);
}

/** Fields logged for a refused attempt: the e-mail only as emailTag, never the password. */
export function refusalLogFields(
  refusal: LoginRefusal,
  email: string,
  address: string,
): { by: LoginRefusal["by"]; email: string; address: string; retryInMin: number } {
  return { by: refusal.by, email: emailTag(email), address, retryInMin: refusal.retryInMin };
}
