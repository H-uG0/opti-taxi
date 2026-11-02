import type { Metadata, Viewport } from "next";
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
