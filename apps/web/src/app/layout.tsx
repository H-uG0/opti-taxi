import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { DemoBanner } from "@/components/demo/demo-banner";
import { isDemoMode } from "@/lib/demo";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Opti-Taxi", template: "%s · Opti-Taxi" },
  description: "Planification des tournées J+1 — taxi conventionné, VSL et ambulance",
  applicationName: "Opti-Taxi",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#1f5e5b",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The Content-Security-Policy nonce (src/proxy.ts) reaches only pages rendered
  // per request. Every page reads the session cookie anyway; this also renders
  // the 404 page per request instead of prerendering it with nonce-less scripts.
  await connection();
  return (
    <html lang="fr">
      {/* Demo mode: the banner's height, which the full-height layouts leave free (globals.css). */}
      <body className={isDemoMode() ? "min-h-dvh [--demo-banner-h:1.5rem]" : "min-h-dvh"}>
        <DemoBanner />
        {children}
      </body>
    </html>
  );
}
