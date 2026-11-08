// Supabase clients need only the project's base address, e.g.
// https://abcd1234.supabase.co. People often paste a longer address from the
// dashboard (".../rest/v1/"), which makes every call fail with
// "Invalid path specified in request URL". Keep just the scheme and host.
export function supabaseBaseUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).origin;
  } catch {
    return "";
  }
}
