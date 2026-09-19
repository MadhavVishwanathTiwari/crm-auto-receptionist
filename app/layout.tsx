import type { Metadata } from "next";

import { Toaster } from "@/components/ui/Toaster";

import "./globals.css";

export const metadata: Metadata = {
  title: "Outreach Ops",
  description: "AutoReceptionist outbound pipeline",
};

// System fonts on purpose: next/font/google adds a build-time network fetch and
// a layout-shift budget for zero benefit in an internal, desktop-only tool.
// Props are typed explicitly rather than via Next's generated `LayoutProps`
// global, so `tsc --noEmit` works on a clean checkout without a build first.
//
// The Toaster is mounted here rather than in (app) for two reasons. It has to
// be above ViewerZone, which keys its children by zone and remounts them the
// first time a browser reports a zone the cookie disagrees with -- that would
// take an in-flight toast with it. And mounting at the root means /login and
// /no-access can speak too.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
