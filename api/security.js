// Secret-question endpoints. Runs only on the server: it uses the Supabase
// secret key (SUPABASE_SECRET_KEY), which must never be sent to the browser.
//
// POST JSON { action, ... }
//   status   (Authorization: Bearer <access token>)            -> { hasQuestion, question, presets }
//   set      (Authorization: Bearer <access token>) question, answer
//   question email                                             -> { question }
//   reset    email, answer, newPassword

import { createClient } from "@supabase/supabase-js";
import { makeSecurity, UserError } from "../lib/security.js";

let security = null;

function getSecurity() {
  if (security) return security;
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) return null;
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const table = () => admin.from("security_questions");
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

  security = makeSecurity({
    async getUserFromToken(token) {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data?.user ? null : { id: data.user.id, email: data.user.email };
    },
    store: {
      getById: async (id) => must(await table().select("*").eq("user_id", id).maybeSingle()),
      getByEmail: async (email) => must(await table().select("*").eq("email", email).maybeSingle()),
      upsert: async (row) => must(await table().upsert(row, { onConflict: "user_id" })),
      update: async (id, fields) => must(await table().update(fields).eq("user_id", id)),
    },
    async setPassword(userId, password) {
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) throw new UserError(error.message, 400);
    },
  });
  return security;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  const sec = getSecurity();
  if (!sec) {
    return res.status(503).json({ error: "Password reset isn't set up yet. Ask the site owner to add SUPABASE_SECRET_KEY in Vercel." });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  try {
    switch (body.action) {
      case "status": return res.status(200).json(await sec.status(token));
      case "set": return res.status(200).json(await sec.set(token, body.question, body.answer));
      case "question": return res.status(200).json(await sec.question(body.email));
      case "reset": return res.status(200).json(await sec.reset(body.email, body.answer, body.newPassword));
      default: return res.status(400).json({ error: "Unknown action" });
    }
  } catch (e) {
    if (e instanceof UserError) return res.status(e.status).json({ error: e.message });
    console.error("security endpoint error:", e);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
