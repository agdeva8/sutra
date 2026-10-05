#!/usr/bin/env node
// Port Dashboard — single port that lists your other dev ports and proxies them.
//
// Run:    node scripts/port-dashboard.js
// Open:   http://localhost:3400
// Tunnel: cloudflared tunnel --url http://localhost:3400   (quick, random URL)
//   or:  add `service: http://localhost:3400` to your named tunnel ingress.
//
// To change the port list, edit PORTS below. To change the dashboard port,
// set DASHBOARD_PORT (default 3400).

const http = require("http");
const net = require("net");

const PORTS = [
  ...Array.from({ length: 11 }, (_, i) => 3000 + i), // 3000..3010
  6934,
];

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || "3400", 10);

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
};

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

const indexPage = () => {
  const cards = PORTS.map((p) => `
    <a class="card" data-port="${p}" href="/p/${p}/">
      <span class="port">${p}</span>
      <span class="hint">localhost:${p}</span>
      <span class="status" data-port="${p}">checking…</span>
    </a>`).join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Port Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:dark}
  body{font-family:-apple-system,system-ui,Segoe UI,sans-serif;background:#0b0d10;color:#e6e6e6;margin:0;padding:32px;max-width:1100px;margin:0 auto}
  h1{font-size:18px;margin:0 0 6px;font-weight:600}
  .sub{font-size:12px;color:#7a8590;margin-bottom:24px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}
  .card{display:block;padding:16px;background:#161a1f;border:1px solid #232830;border-radius:10px;text-decoration:none;color:inherit;transition:border-color .15s,transform .1s}
  .card:hover{border-color:#4a90e2}
  .card:active{transform:scale(.98)}
  .port{font-size:22px;font-weight:600;display:block}
  .hint{font-size:11px;color:#7a8590;margin-top:2px;display:block;font-family:ui-monospace,Menlo,monospace}
  .status{font-size:11px;margin-top:10px;display:block;padding:3px 8px;border-radius:4px;width:fit-content;background:#232830;color:#7a8590}
  .status.up{background:#052e1a;color:#4ade80}
  .status.down{background:#3a0d0d;color:#f87171}
  .refresh{margin-left:8px;font-size:11px;color:#7a8590;background:none;border:1px solid #232830;padding:4px 8px;border-radius:4px;cursor:pointer;color:#7a8590}
  .refresh:hover{border-color:#4a90e2;color:#e6e6e6}
</style></head>
<body>
  <h1>Port Dashboard</h1>
  <div class="sub">localhost:${DASHBOARD_PORT} · click a port to open it
    <button class="refresh" onclick="checkAll()">refresh</button></div>
  <div class="grid">${cards}</div>
<script>
  const checkOne = async (p) => {
    const el = document.querySelector('.status[data-port="' + p + '"]');
    try {
      const r = await fetch('/api/probe?port=' + p, { cache: 'no-store' });
      const j = await r.json();
      el.textContent = j.up ? '● up' : '○ down';
      el.className = 'status ' + (j.up ? 'up' : 'down');
    } catch { el.textContent = '? error'; el.className = 'status down'; }
  };
  const checkAll = () => PORTS.forEach(checkOne);
  checkAll();
  setInterval(checkAll, 5000);
</script>
</body></html>`;
};

const viewerPage = (port) => `<!doctype html>
<html><head><meta charset="utf-8"><title>:${port}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:dark}
  body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#0b0d10;color:#e6e6e6;height:100vh;display:flex;flex-direction:column}
  .bar{display:flex;align-items:center;gap:14px;padding:10px 16px;background:#161a1f;border-bottom:1px solid #232830;flex-shrink:0}
  .back{color:#4a90e2;text-decoration:none;font-size:14px;font-weight:500}
  .back:hover{text-decoration:underline}
  .label{font-size:13px;color:#7a8590;font-family:ui-monospace,Menlo,monospace}
  .reload{color:#7a8590;text-decoration:none;font-size:13px;background:none;border:1px solid #232830;padding:4px 10px;border-radius:4px;cursor:pointer}
  .reload:hover{border-color:#4a90e2;color:#e6e6e6}
  .spacer{flex:1}
  iframe{display:block;flex:1;width:100%;border:0;background:#fff}
</style></head>
<body>
  <div class="bar">
    <a class="back" href="/">← Back</a>
    <span class="label">localhost:${port}</span>
    <button class="reload" onclick="document.querySelector('iframe').src='/r/${port}/'">reload</button>
    <span class="spacer"></span>
    <a class="reload" href="/r/${port}/" target="_blank">open raw ↗</a>
  </div>
  <iframe src="/r/${port}/"></iframe>
</body></html>`;

// HTTP proxy — strips X-Frame-Options / CSP so iframes can embed the page.
const proxyHttp = (req, res, port) => {
  const path = req.url.replace(new RegExp(`^/r/${port}`), "") || "/";
  const opts = {
    hostname: "127.0.0.1",
    port,
    method: req.method,
    path,
    headers: { ...req.headers, host: `localhost:${port}` },
  };
  const upstream = http.request(opts, (up) => {
    const headers = { ...up.headers };
    delete headers["x-frame-options"];
    delete headers["content-security-policy"];
    res.writeHead(up.statusCode || 502, headers);
    up.pipe(res);
  });
  upstream.on("error", (err) =>
    send(res, 502, `Upstream localhost:${port} unreachable: ${err.code || err.message}\n`, { "content-type": "text/plain" })
  );
  req.pipe(upstream);
};

// Raw TCP tunnel — handles WebSockets (HMR) and any other upgraded connection.
const proxyRaw = (req, res, port) => {
  const path = req.url.replace(new RegExp(`^/r/${port}`), "") || "/";
  const target = net.connect(port, "127.0.0.1");
  target.on("connect", () => {
    const head = [`${req.method} ${path} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === "host") head.push(`host: localhost:${port}`);
      else head.push(`${k}: ${v}`);
    }
    head.push("", "");
    target.write(head.join("\r\n"));
    target.pipe(res);
    req.pipe(target);
  });
  target.on("error", (err) => {
    if (!res.headersSent) send(res, 502, `Upstream localhost:${port} unreachable: ${err.code || err.message}\n`);
    else res.end();
  });
  req.on("error", () => target.destroy());
  res.on("error", () => target.destroy());
};

const proxy = (req, res, port) => {
  const upgrade = (req.headers.upgrade || "").toLowerCase();
  if (upgrade === "websocket" || upgrade === "tcp") proxyRaw(req, res, port);
  else proxyHttp(req, res, port);
};

const probe = (port) =>
  new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    let done = false;
    const finish = (up) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ port, up });
    };
    sock.setTimeout(1000);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url || "/";

    if (url === "/" || url === "/index.html") {
      return send(res, 200, indexPage(), { "content-type": "text/html; charset=utf-8" });
    }

    if (url.startsWith("/api/probe")) {
      const u = new URL(req.url, `http://localhost:${DASHBOARD_PORT}`);
      const port = parseInt(u.searchParams.get("port") || "0", 10);
      if (!PORTS.includes(port)) return send(res, 400, JSON.stringify({ error: "port not in allowlist" }), { "content-type": "application/json" });
      const result = await probe(port);
      return send(res, 200, JSON.stringify(result), { "content-type": "application/json" });
    }

    let m = url.match(/^\/p\/(\d+)\/?$/);
    if (m) {
      const port = parseInt(m[1], 10);
      if (!PORTS.includes(port)) return send(res, 404, "Port not in allowlist");
      return send(res, 200, viewerPage(port), { "content-type": "text/html; charset=utf-8" });
    }

    m = url.match(/^\/r\/(\d+)(\/.*)?$/);
    if (m) {
      const port = parseInt(m[1], 10);
      if (!PORTS.includes(port)) return send(res, 404, "Port not in allowlist");
      return proxy(req, res, port);
    }

    send(res, 404, "Not found\n");
  } catch (err) {
    send(res, 500, `Server error: ${err.message}\n`, { "content-type": "text/plain" });
  }
});

server.listen(DASHBOARD_PORT, "127.0.0.1", () => {
  console.log(`Port dashboard:  http://localhost:${DASHBOARD_PORT}`);
  console.log(`Allowed ports:   ${PORTS.join(", ")}`);
  console.log(`Tunnel (quick):  cloudflared tunnel --url http://localhost:${DASHBOARD_PORT}`);
  console.log(`Tunnel (named):  add a hostname → service: http://localhost:${DASHBOARD_PORT}`);
});

if (require.main !== module) module.exports = { PORTS, DASHBOARD_PORT };

// ponytail: stripped Content-Encoding pass-through (assumes upstream doesn't re-encode mid-stream).
// ponytail: HTTP proxy uses Node's http.request — handles gzip/chunked natively; only filter is X-Frame-Options + CSP.
// ponytail: WS proxy is raw TCP tunnel so HMR works; doesn't filter response headers (only HTTP path does).
// ponytail: probe uses raw net.connect with 1s timeout; replace with HTTP HEAD if a port needs a real HTTP probe.
// ponytail: no auth — assumes Cloudflare tunnel + Access policy; add basic-auth here if exposing without a tunnel.
