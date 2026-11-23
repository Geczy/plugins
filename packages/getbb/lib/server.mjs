// The page's service: magpie's launcher navigates its frame here. It serves
// the UI and two routes, a snapshot of bb's threads and "open this thread in
// bb", both behind a token only the served page knows.
import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"

const UI = fileURLToPath(new URL("../ui/", import.meta.url))
const TOKEN_HEADER = "x-getbb-token"
// Three bb commands per snapshot; a page polling every few seconds, or two
// pages open at once, share one run inside this window.
const FRESH_MS = 3_000

const STATIC = new Map([
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/view.js", ["view.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/icon.svg", ["../page/icon.svg", "image/svg+xml"]],
])

// After the launcher navigates away, its bridge is gone. This one answers
// the same parent for theme changes and visibility, so the page follows
// magpie's theme and stops polling while hidden.
const BRIDGE = `(() => {
  if (parent === window) return;
  const themed = [], watched = [], waiting = new Map();
  let next = 0;
  const paint = (t) => {
    if (!t) return;
    const root = document.documentElement;
    root.dataset.theme = t.dark ? "dark" : "light";
    root.style.colorScheme = t.dark ? "dark" : "light";
    for (const [k, v] of Object.entries(t.tokens || {})) if (typeof v === "string") root.style.setProperty("--magpie-" + k, v);
  };
  addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.magpie !== 1 || e.source !== parent) return;
    if (m.event === "theme") { paint(m.data); for (const fn of themed) try { fn(m.data); } catch {} return; }
    if (m.event === "visibility") { for (const fn of watched) try { fn(!!m.data?.visible); } catch {} return; }
    const w = waiting.get(m.id);
    if (w) { waiting.delete(m.id); m.error ? w.reject(new Error(m.error)) : w.resolve(m.result); }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    parent.postMessage({ magpie: 1, id, method, params }, "*");
  });
  window.magpie = {
    ready: call("hello").then((h = {}) => { paint(h); return h; }),
    onTheme: (fn) => themed.push(fn),
    onVisibility: (fn) => watched.push(fn),
  };
})();`

const SECURITY = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" }

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), ...SECURITY, ...extra })
  res.end(body)
}
const json = (res, status, value) => send(res, status, JSON.stringify(value), "application/json; charset=utf-8")

// A request whose Host isn't this loopback port is a DNS-rebinding page
// pretending to be this service.
const loopback = (port) => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
const allowedHost = (host, port) => loopback(port).includes(String(host || "").toLowerCase())
// The page is a sandboxed frame, so its fetches carry Origin "null"; a
// fetch from this service's own origin, or none, is fine too.
const allowedOrigin = (origin, port) => !origin || origin === "null" || loopback(port).some((h) => origin === `http://${h}`)

function allowNullOrigin(req, res) {
  if (req.headers.origin !== "null") return
  res.setHeader("Access-Control-Allow-Origin", "null")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", `${TOKEN_HEADER}, content-type`)
  res.setHeader("Vary", "Origin")
}

const escHTML = (v) => String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

// Theme tokens from the launcher: base64 JSON of short strings, nothing else.
function parseTokens(raw) {
  try {
    const value = JSON.parse(Buffer.from(String(raw || ""), "base64").toString("utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([k, v]) => /^[a-z0-9-]{1,40}$/i.test(k) && typeof v === "string" && v.length <= 160))
  } catch {
    return {}
  }
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (c) => {
      size += c.length
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413 }))
        req.destroy()
      } else chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

const failure = (error) => ({ error: { code: error?.code || "error", message: error?.message || "bb failed" } })

export function startServer({ port, bb, host = "127.0.0.1" }) {
  const token = randomBytes(24).toString("base64url")
  let bound = port
  let last = null
  let pending = null

  function snapshot() {
    if (last && Date.now() - last.at < FRESH_MS) return Promise.resolve(last)
    pending ??= bb.snapshot().then(
      (data) => {
        last = data
        return data
      },
    ).finally(() => {
      pending = null
    })
    return pending
  }

  async function handle(req, res) {
    if (!allowedHost(req.headers.host, bound)) return json(res, 403, { error: { code: "invalid_host", message: "invalid host" } })
    if (!allowedOrigin(req.headers.origin, bound)) return json(res, 403, { error: { code: "invalid_origin", message: "invalid origin" } })
    const path = new URL(req.url || "/", "http://x").pathname
    const api = path === "/api/snapshot" || path === "/api/open"

    if (api) {
      allowNullOrigin(req, res)
      if (req.method === "OPTIONS") return send(res, 204, "", "text/plain")
      if (req.headers[TOKEN_HEADER] !== token) return json(res, 401, { error: { code: "unauthorized", message: "missing or wrong token" } })
    }

    if (path === "/api/snapshot" && req.method === "GET") {
      try {
        return json(res, 200, await snapshot())
      } catch (error) {
        return json(res, 502, failure(error))
      }
    }

    if (path === "/api/open" && req.method === "POST") {
      let id
      try {
        id = JSON.parse(await readBody(req))?.id
      } catch (error) {
        return json(res, error?.status || 400, { error: { code: "invalid_value", message: "expected {\"id\": \"thr_…\"}" } })
      }
      try {
        return json(res, 200, await bb.open(id))
      } catch (error) {
        return json(res, error?.code === "invalid_value" ? 400 : 502, failure(error))
      }
    }

    if (api) return json(res, 405, { error: { code: "method_not_allowed", message: "method not allowed" } })
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: { code: "method_not_allowed", message: "method not allowed" } })

    if (path === "/") {
      const q = new URL(req.url || "/", "http://x").searchParams
      const lang = /^zh/i.test(q.get("lang") || "") ? "zh" : "en"
      const html = (await readFile(UI + "index.html", "utf8"))
        .replaceAll("__GETBB_TOKEN__", escHTML(token))
        .replaceAll("__GETBB_THEME__", q.get("theme") === "dark" ? "dark" : "light")
        .replaceAll("__GETBB_LANG__", lang)
        .replaceAll("__GETBB_TOKENS__", escHTML(JSON.stringify(parseTokens(q.get("tokens")))))
      // WebKit's 'self' can match nothing in a sandboxed frame, so the
      // loopback origins are named too. Through `magpie web`, magpie adds
      // its own proxy's origin beside 'self'.
      const own = loopback(bound).slice(0, 2).map((h) => `http://${h}`).join(" ")
      const csp = `default-src 'none'; script-src 'self' ${own}; style-src 'self' 'unsafe-inline' ${own}; img-src 'self' data: ${own}; connect-src 'self' ${own}; base-uri 'none'; form-action 'none'`
      return send(res, 200, req.method === "HEAD" ? "" : html, "text/html; charset=utf-8", { "Content-Security-Policy": csp, "Referrer-Policy": "no-referrer" })
    }
    if (path === "/bridge.js") return send(res, 200, BRIDGE, "text/javascript; charset=utf-8")
    const item = STATIC.get(path)
    if (item) {
      const body = await readFile(UI + item[0])
      res.writeHead(200, { "Content-Type": item[1], "Content-Length": body.length, ...SECURITY })
      return res.end(req.method === "HEAD" ? undefined : body)
    }
    return json(res, 404, { error: { code: "not_found", message: "not found" } })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) json(res, 500, failure(error))
      else res.end()
    })
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.off("error", reject)
      bound = server.address().port
      resolve({
        port: bound,
        token,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
            server.closeIdleConnections?.()
          }),
      })
    })
  })
}
