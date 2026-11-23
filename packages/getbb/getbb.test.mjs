import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index.mjs"
import { BbError, findBb, makeBb, slimThread } from "./lib/bb.mjs"
import { importThreads, nativeSessions, providerIdOf, toSession, turnsOf, uuidOf } from "./lib/import.mjs"
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

describe("import", () => {
  const ev = (seq, type, data) => ({ id: `evt_${seq}`, seq, type, createdAt: 1_795_000_000_000 + seq, data })
  const said = (seq, text, initiator = "user") => ev(seq, "client/turn/requested", { initiator, input: [{ type: "text", text }, { type: "image", url: "x" }] })
  const answered = (seq, text) => ev(seq, "item/completed", { item: { type: "agentMessage", text } })
  const thr = { id: "thr_imp1", title: "Fix login", environmentPath: "/home/opc/app", environmentBranchName: "bb/fix", updatedAt: 1 }

  test("keeps what the user typed and what the agent answered", () => {
    const events = [ev(1, "thread/identity", { providerThreadId: "p-1" }), said(2, "hi"), ev(3, "item/completed", { item: { type: "commandExecution" } }), said(4, "from a thread", "agent"), answered(5, "hello"), answered(6, "  ")]
    expect(turnsOf(events).map((t) => [t.role, t.text])).toEqual([["user", "hi"], ["assistant", "hello"]])
    expect(providerIdOf(events)).toBe("p-1")
    expect(providerIdOf([])).toBeNull()
  })

  test("leaves out prompts a plugin or a parent agent wrote, keeps the user's answers", () => {
    const turn = (seq, text, extra) => ev(seq, "client/turn/requested", { initiator: "user", input: [{ type: "text", text }], ...extra })
    const events = [
      turn(1, "You are the independent advisor", { source: "spawn", originPluginId: "advisor" }),
      turn(2, "[bb automation due:auto_x] You are Knight", { source: "spawn", originPluginId: "automations" }),
      turn(3, "> Image mockup or code?\n\nBuild directly in code", { source: "tell", originPluginId: "provider-codex" }),
      turn(4, "Verify the UI", { source: "spawn" }),
      turn(5, "deploy and migrate", { source: "tell" }),
      turn(6, "[bb automation due:auto_y]\n\nMonitor the archive", { source: "tell" }),
    ]
    const users = (thread) => turnsOf(events, thread).map((t) => t.text)
    expect(users({})).toEqual(["> Image mockup or code?\n\nBuild directly in code", "Verify the UI", "deploy and migrate"])
    expect(users({ parentThreadId: "thr_parent" })).toEqual(["> Image mockup or code?\n\nBuild directly in code", "deploy and migrate"])
  })

  test("a thread becomes a Claude Code session, the same file each time", () => {
    const s = toSession(thr, [said(1, "hi"), answered(2, "hello")])
    expect(s.dir).toBe("-home-opc-app")
    expect(s.name).toBe(`${uuidOf("thr_imp1")}.jsonl`)
    const [title, user, reply] = s.text.trim().split("\n").map((l) => JSON.parse(l))
    expect(title).toEqual({ type: "summary", summary: "Fix login" })
    expect(user).toMatchObject({ type: "user", cwd: "/home/opc/app", gitBranch: "bb/fix", parentUuid: null, message: { role: "user", content: "hi" } })
    expect(reply).toMatchObject({ type: "assistant", parentUuid: user.uuid, message: { role: "assistant", content: [{ type: "text", text: "hello" }] } })
    expect(toSession(thr, [said(1, "hi"), answered(2, "hello")]).text).toBe(s.text)
    expect(toSession(thr, [ev(1, "thread/identity", {})])).toBeNull()
  })

  test("finds the Claude Code and Codex sessions already on this computer", () => {
    const home = mkdtempSync(join(tmpdir(), "getbb-home-"))
    mkdirSync(join(home, ".claude", "projects", "-x"), { recursive: true })
    writeFileSync(join(home, ".claude", "projects", "-x", "c-1.jsonl"), "")
    mkdirSync(join(home, ".codex", "sessions", "2026", "11", "18"), { recursive: true })
    const rollout = join(home, ".codex", "sessions", "2026", "11", "18", "rollout-2026-11-18T20-40-53-01a1f176-c00d-75b2-8f7d-1a7b57ee7abe.jsonl")
    writeFileSync(rollout, "")
    const found = nativeSessions(home)
    rmSync(home, { recursive: true, force: true })
    expect(found.get("c-1")).toBe(join(home, ".claude", "projects", "-x", "c-1.jsonl"))
    expect(found.get("01a1f176-c00d-75b2-8f7d-1a7b57ee7abe")).toBe(rollout)
  })

  test("imports every thread once, leaves this computer's own sessions alone, pages through long threads", async () => {
    const out = mkdtempSync(join(tmpdir(), "getbb-out-"))
    const filler = Array.from({ length: 999 }, (_, i) => ev(i + 2, "item/started", {}))
    const threads = [
      { ...thr, id: "thr_remote" },
      { ...thr, id: "thr_here", environmentPath: "/Users/me/x" },
      { ...thr, id: "thr_empty" },
      { ...thr, id: "thr_long", archivedAt: 5 },
    ]
    const events = {
      thr_remote: [said(1, "hi"), answered(2, "hello")],
      thr_here: [ev(1, "thread/identity", { providerThreadId: "native-1" }), said(2, "hi")],
      thr_empty: [],
      thr_long: [said(1, "first"), ...filler, answered(1001, "last")],
    }
    const calls = []
    const bb = {
      run: async (args) => {
        calls.push(args.join(" "))
        if (args[1] === "list") return threads
        const after = Number(args[args.indexOf("--after-seq") + 1])
        return events[args[2]].filter((e) => e.seq > after).slice(0, Number(args[args.indexOf("--limit") + 1]))
      },
    }
    const ownFile = join(out, "native-1.jsonl")
    writeFileSync(ownFile, "")
    const native = new Map([["native-1", ownFile]])
    const first = await importThreads({ bb, out, native })
    expect(first).toEqual({ threads: 4, written: 2, native: 1, empty: 1, failed: [] })
    expect(calls[0]).toBe("thread list --include-archived --include-hidden")
    expect(calls.filter((c) => c.startsWith("thread messages thr_long"))).toEqual(["thread messages thr_long --limit 1000 --after-seq 0", "thread messages thr_long --limit 1000 --after-seq 1000"])
    const long = readFileSync(join(out, "projects", "-home-opc-app", `${uuidOf("thr_long")}.jsonl`), "utf8")
    expect(long).toContain('"last"')

    calls.length = 0
    expect(await importThreads({ bb, out, native })).toEqual({ threads: 4, written: 0, native: 0, empty: 0, failed: [] })
    expect(calls).toEqual(["thread list --include-archived --include-hidden"])

    // a deleted file and a changed thread are fetched again; so is a thread
    // whose own session the agent has since cleaned up
    rmSync(join(out, "projects", "-home-opc-app", `${uuidOf("thr_remote")}.jsonl`))
    threads[3] = { ...threads[3], updatedAt: 2 }
    rmSync(ownFile)
    expect(await importThreads({ bb, out, native: new Map() })).toMatchObject({ written: 3, native: 0 })
    rmSync(out, { recursive: true, force: true })
  })

  test("rewrites an earlier version's files once, and removes one a native session replaced", async () => {
    const out = mkdtempSync(join(tmpdir(), "getbb-out-"))
    const file = join(out, "projects", "-home-opc-app", `${uuidOf("thr_imp1")}.jsonl`)
    mkdirSync(join(out, "projects", "-home-opc-app"), { recursive: true })
    writeFileSync(file, "old\n")
    writeFileSync(join(out, "bb-import.json"), JSON.stringify({ thr_imp1: { updatedAt: 1, path: file } }))
    const threads = [thr]
    let events = [said(1, "hi"), answered(2, "hello")]
    const bb = { run: async (args) => (args[1] === "list" ? threads : events) }
    expect(await importThreads({ bb, out, native: new Map() })).toMatchObject({ written: 1 })
    expect(readFileSync(file, "utf8")).toContain('"hello"')
    expect(await importThreads({ bb, out, native: new Map() })).toMatchObject({ written: 0 })

    const ownFile = join(out, "native-1.jsonl")
    writeFileSync(ownFile, "")
    events = [ev(0, "thread/identity", { providerThreadId: "native-1" }), ...events]
    threads[0] = { ...thr, updatedAt: 2 }
    expect(await importThreads({ bb, out, native: new Map([["native-1", ownFile]]) })).toMatchObject({ native: 1 })
    expect(existsSync(file)).toBe(false)
    expect(existsSync(ownFile)).toBe(true)
    rmSync(out, { recursive: true, force: true })
  })

  test("a thread that fails is reported and tried again next time", async () => {
    const out = mkdtempSync(join(tmpdir(), "getbb-out-"))
    let broken = true
    const bb = {
      run: async (args) => {
        if (args[1] === "list") return [thr]
        if (broken) throw new BbError("timeout", "bb thread messages: timed out")
        return [said(1, "hi")]
      },
    }
    expect((await importThreads({ bb, out, native: new Map() })).failed).toEqual(["thr_imp1: bb thread messages: timed out"])
    broken = false
    expect(await importThreads({ bb, out, native: new Map() })).toMatchObject({ written: 1, failed: [] })
    rmSync(out, { recursive: true, force: true })
  })
})

test("the host part is magpie's {id, server}", () => {
  expect(plugin.id).toBe("getbb")
  expect(typeof plugin.server).toBe("function")
})
