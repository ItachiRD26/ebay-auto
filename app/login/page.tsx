"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();

  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      router.replace("/");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("invalid-credential") || msg.includes("wrong-password") || msg.includes("user-not-found")) {
        setError("Email o contraseña incorrectos.");
      } else if (msg.includes("too-many-requests")) {
        setError("Demasiados intentos. Intenta más tarde.");
      } else {
        setError("Error al iniciar sesión. Verifica tus datos.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "var(--bg)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "1.5rem",
    }}>
      <div style={{
        width: "100%",
        maxWidth: 400,
        background: "var(--bg2)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "2.5rem 2rem",
        display: "flex",
        flexDirection: "column",
        gap: "1.5rem",
      }}>
        {/* Logo */}
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "2.5rem", marginBottom: "0.5rem" }}>⚡</div>
          <div style={{ fontSize: "1.35rem", fontWeight: 700, color: "var(--text)" }}>DropFlow</div>
          <div style={{ fontSize: "0.8rem", color: "var(--text3)", marginTop: "0.25rem" }}>
            Acceso restringido — solo usuarios autorizados
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            <label style={{ fontSize: "0.8rem", color: "var(--text2)", fontWeight: 500 }}>
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="tu@email.com"
              style={{
                padding: "0.6rem 0.85rem",
                background: "var(--bg3)",
                border: "1px solid var(--border2)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text)",
                fontSize: "0.9rem",
                outline: "none",
                transition: "border-color 0.15s",
              }}
              onFocus={e => (e.target.style.borderColor = "var(--blue)")}
              onBlur={e => (e.target.style.borderColor = "var(--border2)")}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            <label style={{ fontSize: "0.8rem", color: "var(--text2)", fontWeight: 500 }}>
              Contraseña
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              placeholder="••••••••"
              style={{
                padding: "0.6rem 0.85rem",
                background: "var(--bg3)",
                border: "1px solid var(--border2)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text)",
                fontSize: "0.9rem",
                outline: "none",
                transition: "border-color 0.15s",
              }}
              onFocus={e => (e.target.style.borderColor = "var(--blue)")}
              onBlur={e => (e.target.style.borderColor = "var(--border2)")}
            />
          </div>

          {error && (
            <div style={{
              padding: "0.6rem 0.85rem",
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: "var(--radius-sm)",
              color: "var(--red)",
              fontSize: "0.82rem",
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              marginTop: "0.25rem",
              padding: "0.7rem",
              background: loading ? "var(--blue-dim)" : "var(--blue)",
              color: "#fff",
              border: "none",
              borderRadius: "var(--radius-sm)",
              fontWeight: 600,
              fontSize: "0.9rem",
              cursor: loading ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "0.5rem",
              transition: "background 0.15s",
            }}
          >
            {loading ? (
              <>
                <span style={{
                  width: 14,
                  height: 14,
                  border: "2px solid rgba(255,255,255,0.3)",
                  borderTopColor: "#fff",
                  borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                  display: "inline-block",
                }} />
                Ingresando...
              </>
            ) : "Ingresar"}
          </button>
        </form>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
