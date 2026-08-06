import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Outreach Ops",
  description: "AutoReceptionist outbound pipeline",
};

// System fonts on purpose: next/font/google adds a build-time network fetch and
// a layout-shift budget for zero benefit in an internal, desktop-only tool.
// Props are typed explicitly rather than via Next's generated `LayoutProps`
// global, so `tsc --noEmit` works on a clean checkout without a build first.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full">{children}</body>
    </html>
  );
}
