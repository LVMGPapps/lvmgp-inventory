// Secure admin endpoint for in-app user management.
// Holds the service-role key server-side (never in the browser) and only lets
// signed-in admins create users, set passwords, invite, or remove people.
//
// Deploy:  supabase functions deploy admin-users
// Lock down (optional but recommended): set the admins who may manage users:
//   supabase secrets set ADMIN_EMAILS="jen@lvmgp.com,other@lvmgp.com"
// If ADMIN_EMAILS is not set, any signed-in user may manage users.
// (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY are provided automatically.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminEmails = (Deno.env.get("ADMIN_EMAILS") || "")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!token) return json({ error: "Not signed in." }, 401);

    // Identify the caller from their token.
    const asUser = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: { user }, error: uErr } = await asUser.auth.getUser();
    if (uErr || !user) return json({ error: "Not signed in." }, 401);

    const email = (user.email || "").toLowerCase();
    const isAdmin = adminEmails.length === 0 ? true : adminEmails.includes(email);
    if (!isAdmin) return json({ error: "You're not an admin. Ask an admin to manage users." }, 403);

    const admin = createClient(url, serviceKey);
    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === "list") {
      const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });
      if (error) throw error;
      const users = (data.users || []).map((u) => ({
        id: u.id, email: u.email, created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at, confirmed: !!u.email_confirmed_at,
      }));
      return json({ users });
    }

    if (action === "create") {
      const { email: e, password } = body;
      if (!e || !password) return json({ error: "Email and password are required." }, 400);
      const { data, error } = await admin.auth.admin.createUser({ email: e, password, email_confirm: true });
      if (error) throw error;
      return json({ user: { id: data.user.id, email: data.user.email } });
    }

    if (action === "invite") {
      const { email: e, redirectTo } = body;
      if (!e) return json({ error: "Email is required." }, 400);
      const { data, error } = await admin.auth.admin.inviteUserByEmail(e, redirectTo ? { redirectTo } : undefined);
      if (error) throw error;
      return json({ user: { id: data.user.id, email: data.user.email } });
    }

    if (action === "password") {
      const { user_id, password } = body;
      if (!user_id || !password) return json({ error: "user_id and password are required." }, 400);
      const { error } = await admin.auth.admin.updateUserById(user_id, { password });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "delete") {
      const { user_id } = body;
      if (!user_id) return json({ error: "user_id is required." }, 400);
      if (user_id === user.id) return json({ error: "You can't delete your own account." }, 400);
      const { error } = await admin.auth.admin.deleteUser(user_id);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
