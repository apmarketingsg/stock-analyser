import { quotes } from "../lib/data.js";

export default async function handler(req, res) {
  const symbols = String(req.query.symbols || "").split(",").filter(Boolean);
  try {
    const out = await quotes(symbols);
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=900");
    res.status(200).json(out);
  } catch (e) {
    res.status(502).json({ error: `Price lookup failed: ${e.message || e}` });
  }
}
