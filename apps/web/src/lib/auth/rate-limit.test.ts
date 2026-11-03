import { describe, expect, it } from "vitest";
import {
  ADDRESS_RULE,
  addressBucket,
  AttemptLimiter,
  clearLoginFailures,
  clientAddress,
  createLoginLimiters,
  EMAIL_RULE,
  emailKey,
  emailTag,
  gateLoginAttempt,
  proxyHopsWarning,
  refusalLogFields,
  retryMinutes,
  SHARED_ADDRESS_RULE,
  trustedProxyHops,
  UNKNOWN_CLIENT,
  type LimitRule,
} from "./rate-limit";

const MINUTE = 60_000;

/** A clock the test moves by hand. */
function fakeClock(start = Date.UTC(2026, 10, 3, 8, 0)) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

/** One sign-in attempt as the login action makes it: check, then count. */
function attempt(limiter: AttemptLimiter, key: string): boolean {
  if (limiter.retryAfterMs(key) > 0) return false;
  limiter.hit(key);
  return true;
}

describe("AttemptLimiter, e-mail rule (5 failures / 15 min, then 15 min)", () => {
  it("lets 5 attempts through, refuses the 6th for 15 minutes, then lets the e-mail try again", () => {
    const clock = fakeClock();
    const limiter = new AttemptLimiter(EMAIL_RULE, { now: clock.now });
    for (let i = 0; i < 5; i++) {
      expect(attempt(limiter, "paul@example.fr")).toBe(true);
      clock.advance(MINUTE);
    }
    expect(attempt(limiter, "paul@example.fr")).toBe(false);
    // Blocked at the 5th failure (4 min after the 1st): 15 min from then.
    expect(limiter.retryAfterMs("paul@example.fr")).toBe(14 * MINUTE);
    clock.advance(14 * MINUTE - 1);
    expect(attempt(limiter, "paul@example.fr")).toBe(false);
    clock.advance(1);
    expect(limiter.retryAfterMs("paul@example.fr")).toBe(0);
    expect(attempt(limiter, "paul@example.fr")).toBe(true);
  });

  it("counts failures in a sliding 15-minute window", () => {
    const clock = fakeClock();
    const limiter = new AttemptLimiter(EMAIL_RULE, { now: clock.now });
    for (let i = 0; i < 4; i++) limiter.hit("a@example.fr");
    clock.advance(15 * MINUTE);
    // The four old failures left the window: four more are allowed.
    for (let i = 0; i < 4; i++) limiter.hit("a@example.fr");
    expect(limiter.retryAfterMs("a@example.fr")).toBe(0);
    limiter.hit("a@example.fr");
    expect(limiter.retryAfterMs("a@example.fr")).toBe(15 * MINUTE);
  });

  it("a successful sign-in clears the failures of that e-mail only", () => {
    const limiter = new AttemptLimiter(EMAIL_RULE, { now: fakeClock().now });
    for (let i = 0; i < 4; i++) {
      limiter.hit("a@example.fr");
      limiter.hit("b@example.fr");
    }
    limiter.clear("a@example.fr");
    limiter.hit("a@example.fr");
    limiter.hit("b@example.fr");
    expect(limiter.retryAfterMs("a@example.fr")).toBe(0);
    expect(limiter.retryAfterMs("b@example.fr")).toBeGreaterThan(0);
  });

  it("clearing also lifts a block (the 5th attempt was the right password)", () => {
    const limiter = new AttemptLimiter(EMAIL_RULE, { now: fakeClock().now });
    for (let i = 0; i < 5; i++) limiter.hit("a@example.fr");
    expect(limiter.retryAfterMs("a@example.fr")).toBeGreaterThan(0);
    limiter.clear("a@example.fr");
    expect(limiter.retryAfterMs("a@example.fr")).toBe(0);
  });

  it("an unknown key may try", () => {
    const limiter = new AttemptLimiter(EMAIL_RULE);
    expect(limiter.retryAfterMs("nobody@example.fr")).toBe(0);
  });
});

describe("AttemptLimiter, address rule (30 attempts / 5 min, then 5 min)", () => {
  it("allows 30 attempts in 5 minutes and refuses the 31st", () => {
    const clock = fakeClock();
    const limiter = new AttemptLimiter(ADDRESS_RULE, { now: clock.now });
    for (let i = 0; i < 30; i++) {
      expect(attempt(limiter, "192.0.2.10")).toBe(true);
      clock.advance(5_000);
    }
    expect(attempt(limiter, "192.0.2.10")).toBe(false);
    expect(attempt(limiter, "192.0.2.11")).toBe(true);
    clock.advance(5 * MINUTE);
    expect(attempt(limiter, "192.0.2.10")).toBe(true);
  });
});

describe("AttemptLimiter key bound", () => {
  const rule: LimitRule = { limit: 3, windowMs: 10 * MINUTE, blockMs: 10 * MINUTE };

  it("never tracks more than maxKeys keys, dropping expired keys first", () => {
    const clock = fakeClock();
    const limiter = new AttemptLimiter({ limit: 3, windowMs: 5 * MINUTE, blockMs: 10 * MINUTE }, { now: clock.now, maxKeys: 3 });
    for (let i = 0; i < 3; i++) limiter.hit("blocked");
    limiter.hit("old-1");
    limiter.hit("old-2");
    clock.advance(5 * MINUTE);
    // old-1 and old-2 left the window; "blocked" is the oldest key but still blocked.
    limiter.hit("new-1");
    expect(limiter.size).toBe(2);
    limiter.hit("new-2");
    expect(limiter.size).toBe(3);
    expect(limiter.retryAfterMs("blocked")).toBe(5 * MINUTE);
  });

  it("drops the least recently hit keys when every key is live", () => {
    const limiter = new AttemptLimiter(rule, { now: fakeClock().now, maxKeys: 100 });
    for (let i = 0; i < 1_000; i++) limiter.hit(`spray-${i}@example.fr`);
    expect(limiter.size).toBe(100);
    limiter.hit("spray-999@example.fr");
    limiter.hit("spray-999@example.fr");
    expect(limiter.retryAfterMs("spray-999@example.fr")).toBeGreaterThan(0);
    limiter.hit("spray-0@example.fr");
    expect(limiter.size).toBe(100);
  });
});

describe("retryMinutes", () => {
  it("rounds up to whole minutes, at least 1", () => {
    expect(retryMinutes(1)).toBe(1);
    expect(retryMinutes(MINUTE)).toBe(1);
    expect(retryMinutes(MINUTE + 1)).toBe(2);
    expect(retryMinutes(15 * MINUTE)).toBe(15);
    expect(retryMinutes(0)).toBe(1);
  });
});

describe("trustedProxyHops", () => {
  it("reads a small non-negative integer, else 0", () => {
    expect(trustedProxyHops(undefined)).toBe(0);
    expect(trustedProxyHops("")).toBe(0);
    expect(trustedProxyHops(" 1 ")).toBe(1);
    expect(trustedProxyHops("2")).toBe(2);
    expect(trustedProxyHops("-1")).toBe(0);
    expect(trustedProxyHops("1.5")).toBe(0);
    expect(trustedProxyHops("yes")).toBe(0);
    expect(trustedProxyHops("99")).toBe(0);
  });
});

describe("clientAddress", () => {
  it("never trusts X-Forwarded-For without a configured proxy: one shared bucket", () => {
    // Under `next start` alone the header is whatever the client sent, or the socket address.
    expect(clientAddress("203.0.113.7", 0)).toBe(UNKNOWN_CLIENT);
    expect(clientAddress("198.51.100.1, 203.0.113.7", 0)).toBe(UNKNOWN_CLIENT);
    expect(clientAddress(null, 0)).toBe(UNKNOWN_CLIENT);
  });

  it("behind one proxy, takes the entry the proxy appended and ignores what the client sent", () => {
    expect(clientAddress("203.0.113.7", 1)).toBe("203.0.113.7");
    expect(clientAddress("1.2.3.4, 5.6.7.8, 203.0.113.7", 1)).toBe("203.0.113.7");
    expect(clientAddress("not-an-ip, 203.0.113.7", 1)).toBe("203.0.113.7");
  });

  it("behind two proxies, takes the address the outer proxy saw", () => {
    expect(clientAddress("1.2.3.4, 203.0.113.7, 10.0.0.2", 2)).toBe("203.0.113.7");
  });

  it("falls back to the shared bucket on a missing or malformed entry", () => {
    expect(clientAddress(null, 1)).toBe(UNKNOWN_CLIENT);
    expect(clientAddress("", 1)).toBe(UNKNOWN_CLIENT);
    expect(clientAddress("203.0.113.7", 2)).toBe(UNKNOWN_CLIENT);
    expect(clientAddress("203.0.113.7, garbage", 1)).toBe(UNKNOWN_CLIENT);
    expect(clientAddress("203.0.113.7, ", 1)).toBe(UNKNOWN_CLIENT);
    expect(clientAddress("203.0.113.7:51234", 1)).toBe(UNKNOWN_CLIENT);
  });
});

describe("addressBucket", () => {
  it("keeps an IPv4 address, also IPv4-mapped", () => {
    expect(addressBucket("192.0.2.1")).toBe("192.0.2.1");
    expect(addressBucket(" 192.0.2.1 ")).toBe("192.0.2.1");
    expect(addressBucket("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(addressBucket("::FFFF:192.0.2.1")).toBe("192.0.2.1");
  });

  it("groups IPv6 addresses by /64, whatever the notation", () => {
    const bucket = "2001:db8:85a3:8d3::/64";
    expect(addressBucket("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe(bucket);
    expect(addressBucket("2001:0db8:85a3:08d3:ffff:ffff:ffff:ffff")).toBe(bucket);
    expect(addressBucket("2001:db8:85a3:8d3::1")).toBe(bucket);
    expect(addressBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressBucket("::1")).toBe("0:0:0:0::/64");
    expect(addressBucket("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(addressBucket("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
  });

  it("rejects anything that is not an IP address", () => {
    expect(addressBucket("")).toBeNull();
    expect(addressBucket("unknown")).toBeNull();
    expect(addressBucket("example.org")).toBeNull();
    expect(addressBucket("999.1.1.1")).toBeNull();
    expect(addressBucket("[::1]")).toBeNull();
  });
});

describe("proxyHopsWarning", () => {
  it("warns in production when no proxy is trusted", () => {
    expect(proxyHopsWarning(undefined, "production")).toMatch(/TRUSTED_PROXY_HOPS is 0/);
    expect(proxyHopsWarning("", "production")).toMatch(/TRUSTED_PROXY_HOPS is 0/);
    expect(proxyHopsWarning("0", "production")).toMatch(/TRUSTED_PROXY_HOPS=1/);
  });

  it("stays quiet in development and once a proxy is trusted", () => {
    expect(proxyHopsWarning(undefined, "development")).toBeNull();
    expect(proxyHopsWarning("0", "development")).toBeNull();
    expect(proxyHopsWarning("0", undefined)).toBeNull();
    expect(proxyHopsWarning("1", "production")).toBeNull();
    expect(proxyHopsWarning(" 2 ", "production")).toBeNull();
  });

  it("flags an invalid value in any environment, without echoing it", () => {
    for (const nodeEnv of ["development", "production"]) {
      const warning = proxyHopsWarning("yes-please", nodeEnv);
      expect(warning).toMatch(/integer from 0 to 10/);
      expect(warning).not.toContain("yes-please");
    }
    expect(proxyHopsWarning("99", "development")).toMatch(/integer from 0 to 10/);
  });
});

describe("gateLoginAttempt", () => {
  const A = "192.0.2.10";
  const B = "192.0.2.20";

  function setup() {
    const clock = fakeClock();
    return { clock, limiters: createLoginLimiters({ now: clock.now }) };
  }

  it("refuses the 6th attempt on one e-mail for 15 min, whether the account exists or not", () => {
    const { clock, limiters } = setup();
    for (let i = 0; i < 5; i++) expect(gateLoginAttempt(limiters, "x@example.fr", A)).toBeNull();
    expect(gateLoginAttempt(limiters, "x@example.fr", A)).toEqual({ by: "email", retryInMin: 15 });
    // The e-mail is blocked from every address; another e-mail from the same address is not.
    expect(gateLoginAttempt(limiters, "x@example.fr", B)).toEqual({ by: "email", retryInMin: 15 });
    expect(gateLoginAttempt(limiters, "y@example.fr", A)).toBeNull();
    clock.advance(15 * MINUTE);
    expect(gateLoginAttempt(limiters, "x@example.fr", A)).toBeNull();
  });

  it("keys an e-mail on its fixed-size digest, never on the raw text", () => {
    const { limiters } = setup();
    const huge = `${"x".repeat(1_000_000)}@example.fr`;
    for (let i = 0; i < 5; i++) gateLoginAttempt(limiters, huge, A);
    expect(limiters.email.size).toBe(1);
    expect(emailKey(huge)).toHaveLength(64);
    expect(limiters.email.retryAfterMs(emailKey(huge))).toBe(15 * MINUTE);
    expect(limiters.email.retryAfterMs(huge)).toBe(0);
    clearLoginFailures(limiters, huge);
    expect(limiters.email.size).toBe(0);
  });

  it("does not count a refused attempt: hammering a blocked e-mail neither extends its block nor uses the address", () => {
    const { clock, limiters } = setup();
    for (let i = 0; i < 5; i++) gateLoginAttempt(limiters, "x@example.fr", A);
    for (let i = 0; i < 100; i++) {
      clock.advance(1_000);
      expect(gateLoginAttempt(limiters, "x@example.fr", A)?.by).toBe("email");
    }
    // 5 attempts counted on A out of 30: 25 more e-mails may still try from A.
    for (let i = 0; i < 25; i++) expect(gateLoginAttempt(limiters, `spray-${i}@example.fr`, A)).toBeNull();
    expect(gateLoginAttempt(limiters, "spray-25@example.fr", A)?.by).toBe("address");
    // The e-mail block started at the 5th attempt (time 0); the refusals did not extend it.
    clock.advance(15 * MINUTE - 100_000 - 1);
    expect(gateLoginAttempt(limiters, "x@example.fr", B)?.by).toBe("email");
    clock.advance(1);
    expect(gateLoginAttempt(limiters, "x@example.fr", B)).toBeNull();
  });

  it("refuses the 31st attempt from one address for 5 min and does not count it against the e-mail", () => {
    const { clock, limiters } = setup();
    for (let i = 0; i < 30; i++) expect(gateLoginAttempt(limiters, `spray-${i}@example.fr`, A)).toBeNull();
    for (let i = 0; i < 10; i++) {
      expect(gateLoginAttempt(limiters, "victim@example.fr", A)).toEqual({ by: "address", retryInMin: 5 });
    }
    // Another address is not affected, and the refused attempts left the victim's 5 tries intact.
    for (let i = 0; i < 5; i++) expect(gateLoginAttempt(limiters, "victim@example.fr", B)).toBeNull();
    expect(gateLoginAttempt(limiters, "victim@example.fr", B)?.by).toBe("email");
    clock.advance(5 * MINUTE);
    expect(gateLoginAttempt(limiters, "other@example.fr", A)).toBeNull();
  });

  it("shows the longer wait when both the address and the e-mail are blocked", () => {
    const { clock, limiters } = setup();
    for (let i = 0; i < 5; i++) gateLoginAttempt(limiters, "x@example.fr", A);
    clock.advance(MINUTE);
    for (let i = 0; i < 25; i++) gateLoginAttempt(limiters, `spray-${i}@example.fr`, A);
    // Address blocked 5 min from now, e-mail blocked 14 min from now.
    expect(gateLoginAttempt(limiters, "x@example.fr", A)).toEqual({ by: "email", retryInMin: 14 });
    expect(gateLoginAttempt(limiters, "spray-0@example.fr", A)).toEqual({ by: "address", retryInMin: 5 });
  });

  it("counts an allowed attempt at once, before the password is checked", () => {
    const { limiters } = setup();
    // Five parallel requests for one e-mail all pass the gate before any bcrypt ends; a sixth does not.
    const results = Array.from({ length: 6 }, () => gateLoginAttempt(limiters, "x@example.fr", A));
    expect(results.filter((result) => result === null)).toHaveLength(5);
    expect(results[5]?.by).toBe("email");
  });

  it("clears the e-mail failures after a successful sign-in, not the address count", () => {
    const { limiters } = setup();
    for (let i = 0; i < 4; i++) gateLoginAttempt(limiters, "x@example.fr", A);
    clearLoginFailures(limiters, "x@example.fr");
    for (let i = 0; i < 5; i++) expect(gateLoginAttempt(limiters, "x@example.fr", A)).toBeNull();
    expect(gateLoginAttempt(limiters, "x@example.fr", A)?.by).toBe("email");
    // 9 attempts counted on A: 21 left.
    for (let i = 0; i < 21; i++) expect(gateLoginAttempt(limiters, `other-${i}@example.fr`, A)).toBeNull();
    expect(gateLoginAttempt(limiters, "last@example.fr", A)?.by).toBe("address");
  });

  it("puts requests without a trusted address in one shared bucket with its own, higher limit", () => {
    const { clock, limiters } = setup();
    for (let i = 0; i < SHARED_ADDRESS_RULE.limit; i++) {
      expect(gateLoginAttempt(limiters, `driver-${i}@example.fr`, UNKNOWN_CLIENT)).toBeNull();
    }
    expect(SHARED_ADDRESS_RULE.limit).toBeGreaterThan(ADDRESS_RULE.limit);
    expect(gateLoginAttempt(limiters, "late@example.fr", UNKNOWN_CLIENT)).toEqual({ by: "address", retryInMin: 5 });
    // A trusted address keeps its own count.
    expect(gateLoginAttempt(limiters, "late@example.fr", A)).toBeNull();
    clock.advance(5 * MINUTE);
    expect(gateLoginAttempt(limiters, "late@example.fr", UNKNOWN_CLIENT)).toBeNull();
  });
});

describe("refusal log fields", () => {
  it("tag the e-mail with a sha256 prefix and never carry the e-mail itself", () => {
    const fields = refusalLogFields({ by: "email", retryInMin: 15 }, "paul.martin@example.fr", "192.0.2.10");
    expect(fields).toEqual({ by: "email", email: emailTag("paul.martin@example.fr"), address: "192.0.2.10", retryInMin: 15 });
    expect(fields.email).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(fields)).not.toContain("paul");
    expect(JSON.stringify(fields)).not.toContain("example.fr");
  });

  it("give one e-mail the same tag every time and two e-mails different tags", () => {
    expect(emailTag("a@example.fr")).toBe(emailTag("a@example.fr"));
    expect(emailTag("a@example.fr")).not.toBe(emailTag("b@example.fr"));
  });
});
