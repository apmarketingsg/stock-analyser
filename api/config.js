// Hands the browser the Supabase project address and publishable key.
// Both are designed to be public: the database's row-level security rules
// are what stop one user reading another user's portfolio.
import { supabaseBaseUrl } from "../lib/supabase-url.js";

export default function handler(req, res) {
  const url = supabaseBaseUrl(process.env.SUPABASE_URL);
  const key = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "").trim();
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ supabaseUrl: url, supabaseKey: key, configured: Boolean(url && key) });
}
