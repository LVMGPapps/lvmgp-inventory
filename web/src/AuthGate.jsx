import { useState, useEffect } from "react";
import { supabase } from "./supabase";

// Login gate. Sign-ups are disabled in Supabase (invite-only), so only people
// you've invited have accounts. They sign in with email + password.
export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined); // undefined = loading
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  async function signIn() {
    setErr(""); setMsg(""); setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setErr("Wrong email or password — or that address hasn't been invited.");
  }

  async function reset() {
    setErr(""); setMsg("");
    if (!email.trim()) { setErr("Type your email above first, then tap this."); return; }
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
    if (error) setErr("Couldn't send a reset email.");
    else setMsg("Password reset link sent — check your email.");
  }

  if (session === undefined) {
    return <div style={wrap}><p style={{ color: "#71757E" }}>Loading…</p></div>;
  }
  if (!session) {
    return (
      <div style={wrap}>
        <div style={card}>
          <div style={title}>LVMGP Inventory</div>
          <p style={{ color: "#71757E", fontSize: 14, marginTop: 4 }}>Staff sign-in</p>
          <input style={input} type="email" placeholder="you@lvmgp.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input style={input} type="password" placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && signIn()} />
          <button style={btn} onClick={signIn} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          <button style={linkBtn} onClick={reset}>Forgot password?</button>
          {err && <p style={{ color: "#DA431C", fontSize: 13, marginTop: 10 }}>{err}</p>}
          {msg && <p style={{ color: "#0E7C6B", fontSize: 13, marginTop: 10 }}>{msg}</p>}
        </div>
      </div>
    );
  }
  return children;
}

export async function signOut() {
  await supabase.auth.signOut();
}

const wrap = { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#101012", fontFamily: "Inter,system-ui,sans-serif" };
const card = { background: "#fff", borderRadius: 14, padding: 28, width: "min(380px,90%)" };
const title = { fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", fontSize: 24 };
const input = { width: "100%", padding: "11px 12px", border: "1.5px solid #E6E1D6", borderRadius: 8, fontSize: 15, marginTop: 12, boxSizing: "border-box" };
const btn = { width: "100%", marginTop: 12, padding: "12px", border: "none", borderRadius: 9, background: "#E0392B", color: "#fff", fontWeight: 600, fontSize: 15, cursor: "pointer" };
const linkBtn = { width: "100%", marginTop: 10, padding: "6px", border: "none", background: "none", color: "#71757E", fontSize: 13, cursor: "pointer", textDecoration: "underline" };
