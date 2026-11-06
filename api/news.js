import { news } from "../lib/data.js";

export default async function handler(req, res) {
  const { name = "", symbol = "", date = "" } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return res.status(400).json({ error: "bad date", items: [] });
  try {
    const out = await news({ name: String(name), symbol: String(symbol), date: String(date) });
    // Headlines for a past date rarely change, so cache them for a day at the edge.
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).json(out);
  } catch (e) {
    res.status(502).json({ error: `News lookup failed: ${e.message || e}`, items: [] });
  }
}
