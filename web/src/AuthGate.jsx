import { useState, useEffect } from "react";
import { supabase } from "./supabase";

// Invite-only auth. New accounts are created only by inviting people from the
// Supabase dashboard (public sign-up is turned off there). Invited users click
// the emailed link and land on the "Set your password" screen below. Existing
// users sign in with email + password, and can reset a forgotten one.
export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined); // undefined = loading
  const [setPw, setSetPw] = useState(false);          // set-password screen (invite or reset)
  const [mode, setMode] = useState("signin");         // signin | reset
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const hash = window.location.hash || "";
    if (/type=(recovery|invite|signup)/.test(hash)) setSetPw(true); // arrived from an invite or reset link
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") setSetPw(true);
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const clear = () => { setErr(""); setMsg(""); };

  async function signIn() {
    clear(); setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setErr("Wrong email or password — or that address hasn't been invited yet.");
  }

  async function sendReset() {
    clear();
    if (!email.trim()) { setErr("Type your email above first."); return; }
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
    setBusy(false);
    if (error) setErr("Couldn't send a reset email.");
    else setMsg("If that address has an account, a reset link is on its way — check your email.");
  }

  async function savePassword() {
    clear();
    if (password.length < 6) { setErr("Password must be at least 6 characters."); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) setErr(error.message);
    else { setSetPw(false); setPassword(""); setMsg("Password set — you're signed in."); }
  }

  if (session === undefined) return <div style={wrap}><p style={{ color: "#9AA0A6" }}>Loading…</p></div>;

  // Invited or resetting: choose a password (a session already exists from the link).
  if (setPw && session) {
    return (
      <div style={wrap}><div style={card}>
        <div style={title}>Set your password</div>
        <p style={{ color: "#71757E", fontSize: 14, marginTop: 4 }}>Welcome — pick a password to finish.</p>
        <input style={input} type="password" placeholder="New password" value={password}
          onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && savePassword()} autoFocus />
        <button style={btn} onClick={savePassword} disabled={busy}>{busy ? "Saving…" : "Save password"}</button>
        {err && <p style={errS}>{err}</p>}{msg && <p style={okS}>{msg}</p>}
      </div></div>
    );
  }

  if (!session) {
    const submit = mode === "reset" ? sendReset : signIn;
    return (
      <div style={wrap}><div style={card}>
        <div style={title}>LVMGP Inventory</div>
        <p style={{ color: "#71757E", fontSize: 14, marginTop: 4 }}>{mode === "reset" ? "Reset your password" : "Staff sign-in"}</p>
        <input style={input} type="email" placeholder="you@lvmgp.com" value={email}
          onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        {mode !== "reset" && (
          <input style={input} type="password" placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        )}
        <button style={btn} onClick={submit} disabled={busy}>
          {busy ? "Working…" : mode === "reset" ? "Send reset link" : "Sign in"}
        </button>
        <div style={{ marginTop: 12 }}>
          {mode === "reset"
            ? <button style={linkBtn} onClick={() => { setMode("signin"); clear(); }}>← Back to sign in</button>
            : <button style={linkBtn} onClick={() => { setMode("reset"); clear(); }}>Forgot password?</button>}
        </div>
        <p style={{ color: "#B7BBC4", fontSize: 12, marginTop: 14 }}>Accounts are invite-only. Ask an admin to invite your email.</p>
        {err && <p style={errS}>{err}</p>}{msg && <p style={okS}>{msg}</p>}
      </div></div>
    );
  }
  return children;
}

export async function signOut() { await supabase.auth.signOut(); }

const wrap = { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#101012", fontFamily: "Inter,system-ui,sans-serif" };
const card = { background: "#fff", borderRadius: 14, padding: 28, width: "min(380px,90%)" };
const title = { fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", fontSize: 24 };
const input = { width: "100%", padding: "11px 12px", border: "1.5px solid #E6E1D6", borderRadius: 8, fontSize: 15, marginTop: 12, boxSizing: "border-box" };
const btn = { width: "100%", marginTop: 12, padding: "12px", border: "none", borderRadius: 9, background: "#E0392B", color: "#fff", fontWeight: 600, fontSize: 15, cursor: "pointer" };
const linkBtn = { padding: "6px 0", border: "none", background: "none", color: "#71757E", fontSize: 13, cursor: "pointer", textDecoration: "underline" };
const errS = { color: "#DA431C", fontSize: 13, marginTop: 10 };
const okS = { color: "#0E7C6B", fontSize: 13, marginTop: 10 };
