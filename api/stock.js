import { stock, NotFound } from "../lib/data.js";

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || "").trim();
  if (!symbol) return res.status(400).json({ error: "Missing symbol" });
  try {
    const data = await stock(symbol);
    res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600");
    res.status(200).json(data);
  } catch (e) {
    if (e instanceof NotFound) {
      return res.status(404).json({
        error: `No price data found for ${symbol.toUpperCase()}. Check the code, e.g. D05.SI for DBS on SGX, AAPL for Apple.`,
      });
    }
    res.status(502).json({ error: `Could not load ${symbol.toUpperCase()}: ${e.message || e}` });
  }
}
