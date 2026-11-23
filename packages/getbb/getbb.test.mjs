import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index.mjs"
import { BbError, findBb, makeBb, slimThread } from "./lib/bb.mjs"
import { startServer } from "./lib/server.mjs"

const scope = {}
new Function("globalThis", readFileSync(new URL("./ui/view.js", import.meta.url), "utf8"))(scope)
const V = scope.GetbbView

const thread = (over = {}) => ({ id: "thr_a", projectId: "p1", title: "A", status: "idle", needsYou: false, queued: null, updatedAt: 1000, ...over })

describe("view", () => {
  test("a thread waiting on you outranks its running state", () => {
    expect(V.statusOf(thread({ status: "active", needsYou: true }))).toBe("waiting")
    expect(V.statusOf(thread({ status: "active" }))).toBe("active")
    expect(V.statusOf(thread({ status: "error" }))).toBe("error")
    expect(V.statusOf(thread({ queued: "message" }))).toBe("active")
    expect(V.statusOf(thread())).toBe("idle")
  })

  test("summarize counts each status", () => {
    const list = [thread({ status: "active" }), thread({ status: "error" }), thread({ needsYou: true }), thread()]
    expect(V.summarize(list)).toEqual({ active: 1, waiting: 1, error: 1, total: 4 })
  })

  test("filter by status and by text in title, branch or provider", () => {
    const list = [thread({ id: "thr_1", title: "Fix login", status: "active" }), thread({ id: "thr_2", title: "Docs", branch: "fix/readme", providerId: "codex" })]
    expect(V.filterThreads(list, { filter: "active" }).map((t) => t.id)).toEqual(["thr_1"])
    expect(V.filterThreads(list, { query: "README" }).map((t) => t.id)).toEqual(["thr_2"])
    expect(V.filterThreads(list, { query: "codex" }).map((t) => t.id)).toEqual(["thr_2"])
    expect(V.filterThreads(list, { query: "nothing" })).toEqual([])
  })

  test("groups by project, latest project first, attention first inside", () => {
    const list = [
      thread({ id: "thr_old", projectId: "p1", updatedAt: 10 }),
      thread({ id: "thr_new", projectId: "p2", updatedAt: 50 }),
      thread({ id: "thr_err", projectId: "p1", status: "error", updatedAt: 5 }),
      thread({ id: "thr_idle", projectId: "p1", updatedAt: 20 }),
    ]
    const groups = V.groupByProject(list, [{ id: "p1", name: "One" }, { id: "p2", name: "Two" }])
    expect(groups.map((g) => g.name)).toEqual(["Two", "One"])
    expect(groups[1].threads.map((t) => t.id)).toEqual(["thr_err", "thr_idle", "thr_old"])
  })

  test("relative time in both languages", () => {
    expect(V.ago(0, 3_000)).toBe("just now")
    expect(V.ago(0, 5 * 60_000)).toBe("5m ago")
    expect(V.ago(0, 3 * 3_600_000, "zh")).toBe("3 小时前")
    expect(V.text("zh-CN").open).toBe("在 bb 中打开")
    expect(V.text("fr").open).toBe("Open in bb")
  })
})

// A stand-in bb: prints what the real one prints for the three list
// commands, the error envelope for anything else.
let dir
let fake
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "getbb-test-"))
  fake = join(dir, "bb")
  writeFileSync(
    fake,
    `#!/bin/sh
case "$1 $2" in
  "thread list") echo '[{"id":"thr_1","projectId":"p1","title":null,"titleFallback":"Fallback","status":"idle","runtime":{"displayStatus":"active"},"hasPendingInteraction":false,"queuedWork":"none","environmentBranchName":"bb/x","pinnedAt":null,"updatedAt":5,"secret":"not for the page"}]' ;;
  "project list") echo '[{"id":"p1","name":"One","rootPath":"/x"}]' ;;
  "machine list") echo '[{"id":"m1","name":"mac","status":"connected","type":"host"}]' ;;
  "thread open") echo '{"ok":true}' > "${dir}/opened-$3" ; echo '{"ok":true}' ;;
  *) echo '{"ok":false,"error":{"code":"not_found","message":"no such thing"}}' ; exit 1 ;;
esac
`,
  )
  chmodSync(fake, 0o755)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("bb", () => {
  test("bbPath, when set, is the only place looked", () => {
    expect(findBb(fake, { PATH: "" })).toBe(fake)
    expect(findBb(join(dir, "missing"), { PATH: dir })).toBeNull()
    expect(findBb("", { PATH: dir })).toBe(fake)
    expect(findBb("", { PATH: "", BB_CLI: fake })).toBe(fake)
  })

  test("snapshot keeps only what the page shows", async () => {
    const snap = await makeBb({ bbPath: fake }).snapshot()
    expect(snap.threads).toEqual([
      { id: "thr_1", projectId: "p1", parentThreadId: null, title: "Fallback", status: "active", needsYou: false, queued: null, providerId: null, branch: "bb/x", pinned: false, updatedAt: 5 },
    ])
    expect(snap.projects).toEqual([{ id: "p1", name: "One" }])
    expect(snap.machines).toEqual([{ id: "m1", name: "mac", status: "connected" }])
  })

  test("bb's error envelope becomes a BbError with its code", async () => {
    const err = await makeBb({ bbPath: fake }).run(["nope"]).catch((e) => e)
    expect(err).toBeInstanceOf(BbError)
    expect(err.code).toBe("not_found")
    expect(err.message).toBe("no such thing")
  })

  test("a missing bb says so", async () => {
    const err = await makeBb({ bbPath: join(dir, "missing") }).snapshot().catch((e) => e)
    expect(err.code).toBe("bb_not_found")
  })

  test("open runs bb thread open only for a thread id", async () => {
    const bb = makeBb({ bbPath: fake })
    expect(await bb.open("thr_abc123")).toEqual({ ok: true })
    expect(readFileSync(join(dir, "opened-thr_abc123"), "utf8")).toContain("ok")
    for (const bad of ["--help", "thr_1; rm -rf /", "", null]) {
      expect((await bb.open(bad).catch((e) => e)).code).toBe("invalid_value")
    }
  })

  test("slimThread drops fields the page doesn't use", () => {
    expect(Object.keys(slimThread({ id: "thr_1", secret: 1 }))).not.toContain("secret")
  })
})

// node:http so the test can send any Host and Origin it likes.
function call(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = ""
      res.on("data", (c) => (data += c))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })
}

describe("server", () => {
  let svc
  const opened = []
  const bb = {
    snapshot: async () => ({ at: 1, threads: [], projects: [], machines: [] }),
    open: async (id) => {
      if (!/^thr_/.test(String(id))) throw new BbError("invalid_value", "not a thread id")
      opened.push(id)
      return { ok: true }
    },
  }
  beforeAll(async () => {
    svc = await startServer({ port: 0, bb })
  })
  afterAll(() => svc.close())

  test("serves the page with its token and a strict policy", async () => {
    const res = await call(svc.port, { path: "/?theme=dark&lang=zh-CN" })
    expect(res.status).toBe(200)
    expect(res.body).toContain(`content="${svc.token}"`)
    expect(res.body).toContain('data-theme="dark"')
    expect(res.body).toContain('lang="zh"')
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'")
    expect(res.headers["access-control-allow-origin"]).toBeUndefined()
  })

  test("the API wants the token", async () => {
    expect((await call(svc.port, { path: "/api/snapshot" })).status).toBe(401)
    const res = await call(svc.port, { path: "/api/snapshot", headers: { "x-getbb-token": svc.token } })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).threads).toEqual([])
  })

  test("refuses another Host or Origin", async () => {
    expect((await call(svc.port, { headers: { host: `evil.example:${svc.port}` } })).status).toBe(403)
    expect((await call(svc.port, { path: "/api/snapshot", headers: { origin: "https://evil.example", "x-getbb-token": svc.token } })).status).toBe(403)
  })

  test("answers the sandboxed frame's preflight", async () => {
    const res = await call(svc.port, { method: "OPTIONS", path: "/api/open", headers: { origin: "null" } })
    expect(res.status).toBe(204)
    expect(res.headers["access-control-allow-origin"]).toBe("null")
    expect(res.headers["access-control-allow-headers"]).toContain("x-getbb-token")
  })

  test("open passes a thread id to bb and refuses anything else", async () => {
    const auth = { "x-getbb-token": svc.token, "content-type": "application/json", origin: "null" }
    const ok = await call(svc.port, { method: "POST", path: "/api/open", headers: auth, body: JSON.stringify({ id: "thr_x1" }) })
    expect(ok.status).toBe(200)
    expect(opened).toEqual(["thr_x1"])
    const bad = await call(svc.port, { method: "POST", path: "/api/open", headers: auth, body: JSON.stringify({ id: "--help" }) })
    expect(bad.status).toBe(400)
    expect((await call(svc.port, { method: "POST", path: "/api/open", headers: auth, body: "{" })).status).toBe(400)
  })

  test("a failing bb comes back as its error", async () => {
    const broken = await startServer({ port: 0, bb: { snapshot: async () => Promise.reject(new BbError("bb_not_found", "no bb")) } })
    const res = await call(broken.port, { path: "/api/snapshot", headers: { "x-getbb-token": broken.token } })
    await broken.close()
    expect(res.status).toBe(502)
    expect(JSON.parse(res.body).error.code).toBe("bb_not_found")
  })

  test("serves the UI's files", async () => {
    for (const path of ["/app.js", "/view.js", "/style.css", "/icon.svg", "/bridge.js"]) {
      expect((await call(svc.port, { path })).status).toBe(200)
    }
    expect((await call(svc.port, { path: "/../package.json" })).status).toBe(404)
  })
})

test("the host part is magpie's {id, server}", () => {
  expect(plugin.id).toBe("getbb")
  expect(typeof plugin.server).toBe("function")
})
