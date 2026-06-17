import { createClient } from "@supabase/supabase-js";

// Set in Cloudflare Pages env (and .env.local for dev). The anon key is safe to
// ship to the browser — Row Level Security + invite-only Auth do the gating.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);
