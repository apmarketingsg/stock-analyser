import { search } from "../lib/data.js";

export default async function handler(req, res) {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(200).json([]);
  try {
    const out = await search(q);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json(out);
  } catch (e) {
    res.status(502).json({ error: `Search failed: ${e.message || e}` });
  }
}
