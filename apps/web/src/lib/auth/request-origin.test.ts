import { describe, expect, it } from "vitest";
import { requestOrigin, userAgentHash } from "./request-origin";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";

describe("requestOrigin", () => {
  it("keeps the client address only behind a trusted proxy", () => {
    expect(requestOrigin({ forwardedFor: "198.51.100.4, 203.0.113.7", userAgent: UA }, 1).ip).toBe("203.0.113.7");
    expect(requestOrigin({ forwardedFor: "203.0.113.7", userAgent: UA }, 0).ip).toBeNull();
    expect(requestOrigin({ forwardedFor: "pas une IP", userAgent: UA }, 1).ip).toBeNull();
    expect(requestOrigin({ forwardedFor: "::ffff:192.0.2.1", userAgent: null }, 1).ip).toBe("192.0.2.1");
    expect(requestOrigin({ forwardedFor: "2001:DB8::1", userAgent: null }, 1).ip).toBe("2001:db8::1");
  });

  it("hashes the User-Agent, never stores it", () => {
    const origin = requestOrigin({ forwardedFor: null, userAgent: UA }, 1);
    expect(origin.userAgentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(origin.userAgentHash).toBe(userAgentHash(`  ${UA} `));
    expect(JSON.stringify(origin)).not.toContain("iPhone");
    expect(userAgentHash("")).toBeNull();
    expect(userAgentHash(null)).toBeNull();
  });
});
