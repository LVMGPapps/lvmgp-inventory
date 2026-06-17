import { useState, useEffect } from "react";
import { supabase } from "./supabase";

// Login gate. Sign-ups are disabled in Supabase, so only invited emails can get
// a link (shouldCreateUser:false). Wrap the app:  <AuthGate><App/></AuthGate>
export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined); // undefined = loading
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  async function sendLink() {
    setErr("");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
    });
    if (error) setErr("That email isn't on the approved list. Ask an admin to invite you.");
    else setSent(true);
  }

  if (session === undefined) {
    return <div style={wrap}><p style={{ color: "#71757E" }}>Loading…</p></div>;
  }
  if (!session) {
    return (
      <div style={wrap}>
        <div style={card}>
          <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", fontSize: 24 }}>
            LVMGP Inventory
          </div>
          <p style={{ color: "#71757E", fontSize: 14, marginTop: 4 }}>Staff sign-in</p>
          {sent ? (
            <p style={{ marginTop: 16 }}>Check your email for a sign-in link.</p>
          ) : (
            <>
              <input
                style={input} type="email" placeholder="you@lvmgp.com" value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendLink()}
              />
              <button style={btn} onClick={sendLink}>Email me a sign-in link</button>
              {err && <p style={{ color: "#DA431C", fontSize: 13, marginTop: 10 }}>{err}</p>}
            </>
          )}
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
const input = { width: "100%", padding: "11px 12px", border: "1.5px solid #E6E1D6", borderRadius: 8, fontSize: 15, marginTop: 14, boxSizing: "border-box" };
const btn = { width: "100%", marginTop: 10, padding: "12px", border: "none", borderRadius: 9, background: "#E0392B", color: "#fff", fontWeight: 600, fontSize: 15, cursor: "pointer" };
