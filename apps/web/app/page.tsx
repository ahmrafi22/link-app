const styles = {
  main: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#0b0f14",
    color: "#e6edf3",
  } as React.CSSProperties,
  card: {
    maxWidth: 420,
    padding: "32px 36px",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.05)",
  } as React.CSSProperties,
  h1: { margin: "0 0 8px", fontSize: 24 } as React.CSSProperties,
  p: { margin: "0 0 16px", lineHeight: 1.6, color: "#9aa7b4" } as React.CSSProperties,
  code: { color: "#7ee2a8" },
};

export default function Home() {
  return (
    <main style={styles.main}>
      <div style={styles.card}>
        <h1 style={styles.h1}>🔐 Link Vault</h1>
        <p style={styles.p}>
          Personal capture API. The triage web UI lands in a later phase — for
          now this deployment hosts the capture endpoints.
        </p>
        <p style={styles.p}>
          Health check: <a href="/api/health" style={styles.code}>/api/health</a>
        </p>
      </div>
    </main>
  );
}
