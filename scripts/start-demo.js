const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "demo-dist");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png" };

function createDemoServer({ rootDir = ROOT } = {}) {
  const safeRoot = path.resolve(rootDir);
  return http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname); }
    catch { response.writeHead(400).end("Bad request"); return; }
    if (pathname === "/demo-api" || pathname.startsWith("/demo-api/")) {
      response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "Demo API runs in this browser." }));
      return;
    }
    if (!new Set(["GET", "HEAD"]).has(request.method)) { response.writeHead(405).end("Method not allowed"); return; }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(safeRoot, relative);
    if (filePath !== safeRoot && !filePath.startsWith(safeRoot + path.sep)) { response.writeHead(403).end("Forbidden"); return; }
    fs.stat(filePath, (error, stat) => {
      if (error || !stat.isFile()) { response.writeHead(404).end("Not found"); return; }
      response.writeHead(200, { "Content-Type": TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
      if (request.method === "HEAD") response.end();
      else fs.createReadStream(filePath).pipe(response);
    });
  });
}

if (require.main === module) {
  if (!fs.existsSync(path.join(ROOT, "index.html"))) require("./build-demo.js").buildDemo();
  const server = createDemoServer();
  const port = Number(process.env.DOCCARE_DEMO_PORT || 4173);
  server.listen(port, "127.0.0.1", () => process.stdout.write(`DocCare Pro demo: http://127.0.0.1:${port}\n`));
}

module.exports = { createDemoServer };
