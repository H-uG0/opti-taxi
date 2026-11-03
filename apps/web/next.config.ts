import type { NextConfig } from "next";
// Relative import: next.config.ts is compiled on its own, without the "@/" alias.
import { securityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Hardening headers on every response (the app handles health data). The
  // Content-Security-Policy needs a per-request nonce: src/proxy.ts sets it.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders(process.env.NODE_ENV) }];
  },
};

export default nextConfig;
