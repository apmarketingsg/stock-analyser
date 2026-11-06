// Local development server. On Vercel this file is not used: the files in
// api/ become serverless functions and public/ is served as static files.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import search from "./api/search.js";
import stock from "./api/stock.js";
import news from "./api/news.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const routes = { "/api/search": search, "/api/stock": stock, "/api/news": news };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".md": "text/plain" };
const port = Number(process.env.PORT) || 3000;

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = routes[url.pathname];
  if (route) {
    req.query = Object.fromEntries(url.searchParams);
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
    return route(req, res);
  }
  const file = path.join(root, path.normalize(url.pathname === "/" ? "/index.html" : url.pathname));
  if (!file.startsWith(root)) { res.statusCode = 403; return res.end(); }
  try {
    const body = await readFile(file);
    res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
}).listen(port, () => console.log(`Stock Analyser running at http://localhost:${port}`));
