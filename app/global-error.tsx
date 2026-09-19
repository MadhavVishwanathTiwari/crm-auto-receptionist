"use client";

/**
 * The last boundary. It replaces the root layout when the root layout itself
 * is what failed, so it has to render its own <html> and <body> and cannot
 * reach for anything that depends on globals.css having loaded.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#08090a",
          color: "#e8eaed",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          fontSize: 13,
        }}
      >
        <div style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <p style={{ fontSize: 16, fontWeight: 600, margin: "0 0 8px" }}>
            Outreach Ops could not start
          </p>
          <p style={{ color: "#a8aeb4", margin: "0 0 16px" }}>
            {error.message || "The application failed before it could render."}
            {error.digest ? ` (${error.digest})` : ""}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              cursor: "pointer",
              border: "1px solid #32383d",
              background: "#1e2225",
              color: "#e8eaed",
              borderRadius: 6,
              padding: "6px 14px",
              font: "inherit",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
