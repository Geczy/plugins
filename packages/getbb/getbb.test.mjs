import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index.mjs"
import { BbError, daemonClients, findBb, makeBb, slimThread } from "./lib/bb.mjs"
import { folderOf, foldersHere, importThreads, nativeSessions, providerIdOf, toSession, turnsOf, uuidOf } from "./lib/import.mjs"
import { importMemories, makeMagpie, projectEnv, toMemory } from "./lib/memory.mjs"
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

  test("daemonClients offers the daemon's bb with each other loopback port it listens on", async () => {
    const home = mkdtempSync(join(tmpdir(), "getbb-daemon-"))
    const m = join(home, ".bb-machines", "me.getbb.app")
    const bin = join(m, "npm", "lib", "node_modules", "bb-app", "host-daemon", "dist", "bb")
    const node = join(home, "node")
    mkdirSync(join(bin, ".."), { recursive: true })
    writeFileSync(bin, "")
    writeFileSync(node, "")
    writeFileSync(join(m, "host-daemon-port"), "38888\n")
    // a folder with no daemon, and one whose daemon isn't running
    mkdirSync(join(home, ".bb-machines", "empty"))
    mkdirSync(join(home, ".bb-machines", "stopped"))
    writeFileSync(join(home, ".bb-machines", "stopped", "host-daemon-port"), "40000")
    const asked = []
    const sh = async (args) => {
      asked.push(args.join(" "))
      if (args.includes("-t")) return args.includes("-iTCP:38888") ? "71150\n" : ""
      if (args.includes("txt")) return `p71150\nftxt\nn${node}\nftxt\nn/usr/lib/libz.dylib\n`
      return "p71150\nf20\nn127.0.0.1:55393\nf21\nn*:8080\nf22\nn127.0.0.1:38888\nf23\nn[::1]:55395\n"
    }
    expect(await daemonClients(home, sh)).toEqual([
      { cmd: [node, bin], url: "http://127.0.0.1:55393" },
      { cmd: [node, bin], url: "http://[::1]:55395" },
    ])
    expect(asked).toContain("-nP -a -p 71150 -iTCP -sTCP:LISTEN -Fn")
    // a program lsof doesn't name: bb runs by its own first line
    expect((await daemonClients(home, async (args) => (args.includes("txt") ? "" : sh(args))))[0].cmd).toEqual([bin])
    expect(await daemonClients(join(home, "nowhere"), sh)).toEqual([])
    rmSync(home, { recursive: true, force: true })
  })

  test("outside bb, it runs the daemon's bb through the proxy that answers, and looks again after a failure", async () => {
    const through = join(dir, "through-proxy")
    writeFileSync(
      through,
      `#!/bin/sh
[ "$BB_SERVER_URL" = "http://127.0.0.1:2" ] || { echo '{"ok":false,"error":{"code":"http_403","message":"machine not authorized"}}'; exit 1; }
exec "${fake}" "$@"
`,
    )
    chmodSync(through, 0o755)
    let looks = 0
    const viaDaemon = async () => {
      looks++
      return [{ cmd: ["/bin/sh", through], url: "http://127.0.0.1:1" }, { cmd: ["/bin/sh", through], url: "http://127.0.0.1:2" }]
    }
    const bb = makeBb({ env: { PATH: "" }, viaDaemon })
    expect((await bb.snapshot()).threads.map((t) => t.id)).toEqual(["thr_1"])
    expect(looks).toBe(1)
    expect((await bb.run(["nope"]).catch((e) => e)).code).toBe("not_found")
    await bb.run(["project", "list"])
    expect(looks).toBe(2)
    // in a bb thread or terminal, and with bbPath, bb is run as it is
    await makeBb({ bbPath: fake, env: { PATH: "" }, viaDaemon }).run(["project", "list"])
    await makeBb({ env: { PATH: dir, BB_SERVER_URL: "http://x" }, viaDaemon }).run(["project", "list"])
    expect(looks).toBe(2)
    // no daemon here: bb from PATH, looked for again next time
    const none = makeBb({ env: { PATH: dir }, viaDaemon: async () => (looks++, []) })
    await none.run(["project", "list"])
    await none.run(["project", "list"])
    expect(looks).toBe(4)
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
  const thr = { id: "thr_imp1", projectId: "p_app", title: "Fix login", environmentPath: "/home/opc/app", environmentBranchName: "bb/fix", updatedAt: 1 }
  const app = { id: "p_app", sources: [{ type: "local_path", path: "/home/opc/app", isDefault: true }] }
  const here = (p) => p.startsWith("/home/opc/")

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

  test("a thread is filed under its project's folder on this computer, else the home folder", () => {
    const web = { id: "p_web", sources: [{ type: "local_path", path: "/srv/web", isDefault: true }, { type: "local_path", path: "/Users/me/web", isDefault: false }] }
    const mine = (p) => p.startsWith("/Users/me/")
    const at = (environmentPath, project = web) => folderOf({ environmentPath }, project, mine, "/Users/me")
    // where it ran, when that's the project's folder here or inside it
    expect(at("/Users/me/web")).toBe("/Users/me/web")
    expect(at("/Users/me/web/packages/a")).toBe("/Users/me/web/packages/a")
    // on the server, in a worktree elsewhere, nowhere known: the project's folder here
    expect(at("/srv/web")).toBe("/Users/me/web")
    expect(at("/Users/me/.bb/worktrees/web-fix")).toBe("/Users/me/web")
    expect(at("/Users/me/webby")).toBe("/Users/me/web")
    expect(at(null)).toBe("/Users/me/web")
    // Personal, a project with no folder here, a project bb didn't list: home
    expect(at("/Users/me/x/thr_1", { id: "proj_personal", sources: [] })).toBe("/Users/me")
    expect(at("/srv/far", { id: "p_far", sources: [{ type: "local_path", path: "/srv/far", isDefault: true }] })).toBe("/Users/me")
    expect(at("/Users/me/web", null)).toBe("/Users/me")
    const two = { sources: [{ type: "local_path", path: "/Users/me/b", isDefault: false }, { type: "local_path", path: "/Users/me/a", isDefault: true }, { type: "git", path: "/Users/me/c" }] }
    expect(foldersHere(two, mine)).toEqual(["/Users/me/a", "/Users/me/b"])
  })

  test("moves a thread's file once when its project gets a folder on this computer", async () => {
    const out = mkdtempSync(join(tmpdir(), "getbb-out-"))
    const calls = []
    const bb = {
      run: async (args) => {
        calls.push(`${args[0]} ${args[1]}`)
        return args[0] === "project" ? [app] : args[1] === "list" ? [thr] : [said(1, "hi")]
      },
    }
    let cloned = false
    const run = () => importThreads({ bb, out, here, native: new Map(), here: () => cloned, home: "/Users/me" })
    expect(await run()).toMatchObject({ written: 1 })
    const before = join(out, "projects", "-Users-me", `${uuidOf("thr_imp1")}.jsonl`)
    expect(readFileSync(before, "utf8")).toContain('"cwd":"/Users/me"')
    cloned = true
    expect(await run()).toMatchObject({ written: 1 })
    expect(existsSync(before)).toBe(false)
    expect(existsSync(join(out, "projects", "-Users-me"))).toBe(false)
    expect(readFileSync(join(out, "projects", "-home-opc-app", `${uuidOf("thr_imp1")}.jsonl`), "utf8")).toContain('"cwd":"/home/opc/app"')
    calls.length = 0
    expect(await run()).toMatchObject({ written: 0 })
    expect(calls).toEqual(["thread list", "project list"])
    rmSync(out, { recursive: true, force: true })
  })

  test("finds the Claude Code and Codex sessions already on this computer", () => {
    const home = mkdtempSync(join(tmpdir(), "getbb-home-"))
    mkdirSync(join(home, ".claude", "projects", "-x"), { recursive: true })
    writeFileSync(join(home, ".claude", "projects", "-x", "c-1.jsonl"), "")
    mkdirSync(join(home, ".codex", "sessions", "2026", "11", "18"), { recursive: true })
    const rollout = join(home, ".codex", "sessions", "2026", "11", "18", "rollout-2026-11-18T20-40-53-01a1f176-c00d-75b2-8f7d-1a7b57ee7abe.jsonl")
    writeFileSync(rollout, "")
    mkdirSync(join(home, ".codex", "archived_sessions"), { recursive: true })
    const archived = join(home, ".codex", "archived_sessions", "rollout-2026-11-21T08-35-17-01a1fe51-8219-78e3-8511-a4246194b8d5.jsonl")
    writeFileSync(archived, "")
    const found = nativeSessions(home)
    rmSync(home, { recursive: true, force: true })
    expect(found.get("c-1")).toBe(join(home, ".claude", "projects", "-x", "c-1.jsonl"))
    expect(found.get("01a1f176-c00d-75b2-8f7d-1a7b57ee7abe")).toBe(rollout)
    expect(found.get("01a1fe51-8219-78e3-8511-a4246194b8d5")).toBe(archived)
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
        if (args[0] === "project") return [app]
        if (args[1] === "list") return threads
        const after = Number(args[args.indexOf("--after-seq") + 1])
        return events[args[2]].filter((e) => e.seq > after).slice(0, Number(args[args.indexOf("--limit") + 1]))
      },
    }
    const ownFile = join(out, "native-1.jsonl")
    writeFileSync(ownFile, "")
    const native = new Map([["native-1", ownFile]])
    const first = await importThreads({ bb, out, here, native })
    expect(first).toEqual({ threads: 4, written: 2, native: 1, empty: 1, failed: [] })
    expect(calls[0]).toBe("thread list --include-archived --include-hidden")
    expect(calls.filter((c) => c.startsWith("thread messages thr_long"))).toEqual(["thread messages thr_long --limit 1000 --after-seq 0", "thread messages thr_long --limit 1000 --after-seq 1000"])
    const long = readFileSync(join(out, "projects", "-home-opc-app", `${uuidOf("thr_long")}.jsonl`), "utf8")
    expect(long).toContain('"last"')

    calls.length = 0
    expect(await importThreads({ bb, out, here, native })).toEqual({ threads: 4, written: 0, native: 0, empty: 0, failed: [] })
    expect(calls).toEqual(["thread list --include-archived --include-hidden", "project list --include-personal"])

    // a deleted file and a changed thread are fetched again; so is a thread
    // whose own session the agent has since cleaned up
    rmSync(join(out, "projects", "-home-opc-app", `${uuidOf("thr_remote")}.jsonl`))
    threads[3] = { ...threads[3], updatedAt: 2 }
    rmSync(ownFile)
    expect(await importThreads({ bb, out, here, native: new Map() })).toMatchObject({ written: 3, native: 0 })
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
    const bb = { run: async (args) => (args[0] === "project" ? [app] : args[1] === "list" ? threads : events) }
    expect(await importThreads({ bb, out, here, native: new Map() })).toMatchObject({ written: 1 })
    expect(readFileSync(file, "utf8")).toContain('"hello"')
    expect(await importThreads({ bb, out, here, native: new Map() })).toMatchObject({ written: 0 })

    const ownFile = join(out, "native-1.jsonl")
    writeFileSync(ownFile, "")
    events = [ev(0, "thread/identity", { providerThreadId: "native-1" }), ...events]
    threads[0] = { ...thr, updatedAt: 2 }
    expect(await importThreads({ bb, out, here, native: new Map([["native-1", ownFile]]) })).toMatchObject({ native: 1 })
    expect(existsSync(file)).toBe(false)
    expect(existsSync(ownFile)).toBe(true)
    rmSync(out, { recursive: true, force: true })
  })

  test("a thread that fails is reported and tried again next time", async () => {
    const out = mkdtempSync(join(tmpdir(), "getbb-out-"))
    let broken = true
    const bb = {
      run: async (args) => {
        if (args[0] === "project") return [app]
        if (args[1] === "list") return [thr]
        if (broken) throw new BbError("timeout", "bb thread messages: timed out")
        return [said(1, "hi")]
      },
    }
    expect((await importThreads({ bb, out, here, native: new Map() })).failed).toEqual(["thr_imp1: bb thread messages: timed out"])
    broken = false
    expect(await importThreads({ bb, out, here, native: new Map() })).toMatchObject({ written: 1, failed: [] })
    rmSync(out, { recursive: true, force: true })
  })
})

describe("memory", () => {
  const mem = (over = {}) => ({ id: "mem_g", scope: "global", projectId: null, name: "g", summary: "Prefers pnpm", kind: "preference", tags: ["js"], version: 1, ...over })
  const web = { id: "proj_web", sources: [{ type: "local_path", path: "/on/server", isDefault: true }, { type: "local_path", path: "/here/web", isDefault: false }] }
  const personal = { id: "proj_personal", sources: [] }
  const here = (p) => p.startsWith("/here/")

  test("bb reads a project's memories with that project named and the thread's taken away", () => {
    const env = { PATH: "/bin", BB_THREAD_ID: "thr_x", BB_ENVIRONMENT_ID: "env_x", BB_PROJECT_ID: "proj_x" }
    expect(projectEnv("proj_web", env)).toEqual({ PATH: "/bin", BB_PROJECT_ID: "proj_web" })
    expect(projectEnv(null, env)).toBe(env)
  })

  test("a bb memory becomes what memory_save is given", () => {
    expect(toMemory(mem(), null, { writeReason: "said so" }, here)).toEqual({
      text: "Prefers pnpm\nFull record: bb memory get mem_g",
      kind: "preference",
      scope: "global",
      project: null,
      tags: ["js", "bb"],
      why: "said so",
    })
    // a project with a folder on this computer, even when it isn't bb's default
    expect(toMemory(mem({ id: "mem_w", scope: "project", kind: "decision", tags: ["bb"] }), web, {}, here)).toMatchObject({
      text: "Prefers pnpm\nFull record: BB_PROJECT_ID=proj_web bb memory get mem_w",
      kind: "episode",
      scope: "project",
      project: "/here/web",
      tags: ["bb"],
      why: null,
    })
    // Personal and a project with no folder here hold everywhere
    expect(toMemory(mem({ id: "mem_p", scope: "project", summary: "", name: "pis" }), personal, {}, here)).toMatchObject({ text: "pis\nFull record: BB_PROJECT_ID=proj_personal bb memory get mem_p", scope: "global", project: null })
    expect(toMemory(mem({ scope: "project" }), { id: "proj_far", sources: [{ type: "local_path", path: "/on/server" }] }, {}, here).scope).toBe("global")
    expect(toMemory(mem({ kind: "something-new" }), null, {}, here).kind).toBeNull()
  })

  test("saves every bb memory once, changes the same one, sets aside what bb dropped", async () => {
    const out = mkdtempSync(join(tmpdir(), "getbb-mem-"))
    const lists = { global: [mem()], proj_personal: [mem({ id: "mem_p", scope: "project", kind: "decision" })], proj_web: [mem({ id: "mem_w", scope: "project" })] }
    let broken = null
    const bbCalls = []
    const bbFor = (project) => ({
      run: async (args) => {
        bbCalls.push(`${project || "-"} ${args.join(" ")}`)
        if (args[0] === "project") return [personal, web]
        if (args[1] === "get") return { ok: true, memory: { id: args[2], writeReason: `why ${args[2]}` } }
        if (project === broken) throw new BbError("timeout", "timed out")
        const memories = lists[project || "global"]
        return { ok: true, memories, total: memories.length }
      },
    })
    const saves = []
    let next = 0
    let gone = new Set()
    const magpie = {
      status: (id) => (gone.has(id) ? null : "active"),
      tool: async (name, params) => {
        saves.push([name, params])
        if (params.id && gone.has(params.id)) throw new Error("no memory with that id")
        if (name === "memory_forget") return `Set aside: [${params.id}]`
        return params.id ? `Changed: [${params.id}] …` : `Remembered: [m_${(++next).toString(16).padStart(4, "0")}] …`
      },
    }
    const run = () => importMemories({ bbFor, magpie, out, here })

    expect(await run()).toEqual({ memories: 3, saved: 3, changed: 0, forgotten: 0, failed: [] })
    expect(bbCalls).toContain("proj_web memory catalog --scope project --limit 100")
    expect(bbCalls).toContain("- memory catalog --scope global --limit 100")
    expect(bbCalls).toContain("proj_personal memory get mem_p")
    const byText = Object.fromEntries(saves.map(([, p]) => [p.text.split("\n")[1], p]))
    expect(byText["Full record: bb memory get mem_g"]).toMatchObject({ scope: "global", why: "why mem_g" })
    expect(byText["Full record: BB_PROJECT_ID=proj_personal bb memory get mem_p"]).toMatchObject({ scope: "global", kind: "episode" })
    expect(byText["Full record: BB_PROJECT_ID=proj_web bb memory get mem_w"]).toMatchObject({ scope: "project", project: "/here/web" })
    const ids = JSON.parse(readFileSync(join(out, "bb-memory.json"), "utf8"))
    expect(Object.keys(ids).sort()).toEqual(["mem_g", "mem_p", "mem_w"])

    // nothing changed: bb's lists are read, nothing is fetched or saved
    saves.length = bbCalls.length = 0
    expect(await run()).toEqual({ memories: 3, saved: 0, changed: 0, forgotten: 0, failed: [] })
    expect(saves).toEqual([])
    expect(bbCalls.filter((c) => c.includes("memory get"))).toEqual([])

    // a new version goes into the same magpie memory; one magpie no longer
    // has is saved anew
    lists.global = [mem({ version: 2, summary: "Prefers bun" })]
    lists.proj_web = [mem({ id: "mem_w", scope: "project", version: 2 })]
    gone = new Set([ids.mem_w.id])
    saves.length = 0
    expect(await run()).toMatchObject({ saved: 0, changed: 2, failed: [] })
    expect(saves.find(([, p]) => p.text.startsWith("Prefers bun"))[1].id).toBe(ids.mem_g.id)
    expect(saves.filter(([, p]) => p.text.includes("mem_w")).map(([, p]) => p.id)).toEqual([ids.mem_w.id, undefined])

    // while one list can't be read nothing is set aside; once all are, a
    // memory bb dropped is
    lists.proj_personal = []
    broken = "proj_web"
    saves.length = 0
    expect(await run()).toMatchObject({ forgotten: 0, failed: ["proj_web: timed out"] })
    expect(saves).toEqual([])
    broken = null
    expect(await run()).toMatchObject({ memories: 2, forgotten: 1, failed: [] })
    expect(saves).toEqual([["memory_forget", { id: ids.mem_p.id }]])
    expect(Object.keys(JSON.parse(readFileSync(join(out, "bb-memory.json"), "utf8"))).sort()).toEqual(["mem_g", "mem_w"])
    rmSync(out, { recursive: true, force: true })
  })

  test("a memory magpie merged a save into is never changed or set aside from here", async () => {
    const out = mkdtempSync(join(tmpdir(), "getbb-mem-"))
    let list = [mem()]
    const bbFor = () => ({
      run: async (args) => (args[0] === "project" ? [] : args[1] === "get" ? { memory: {} } : { memories: list, total: list.length }),
    })
    const calls = []
    const magpie = {
      tool: async (name, params) => {
        calls.push([name, params.id])
        return "Already remembered, merged: [m_0abc] preference, everywhere: Prefers pnpm"
      },
    }
    const run = () => importMemories({ bbFor, magpie, out, here })
    expect(await run()).toMatchObject({ saved: 1, failed: [] })
    list = [mem({ version: 2 })]
    expect(await run()).toMatchObject({ changed: 1, failed: [] })
    list = []
    expect(await run()).toMatchObject({ forgotten: 0, failed: [] })
    expect(calls).toEqual([["memory_save", undefined], ["memory_save", undefined]])
    expect(JSON.parse(readFileSync(join(out, "bb-memory.json"), "utf8"))).toEqual({})
    rmSync(out, { recursive: true, force: true })
  })

  test("a memory tidy merged is left as it is and bb's change saved anew; one set aside stays aside", async () => {
    const out = mkdtempSync(join(tmpdir(), "getbb-mem-"))
    const fish = (over) => mem({ id: "mem_h", summary: "Uses fish", ...over })
    let list = [mem(), fish()]
    const bbFor = () => ({
      run: async (args) => (args[0] === "project" ? [] : args[1] === "get" ? { memory: {} } : { memories: list, total: list.length }),
    })
    const calls = []
    const status = {}
    let next = 0
    const magpie = {
      status: (id) => status[id] || "active",
      tool: async (name, params) => {
        calls.push([name, params.id])
        return params.id ? `Changed: [${params.id}] …` : `Remembered: [m_${(++next).toString(16).padStart(4, "0")}] …`
      },
    }
    const run = () => importMemories({ bbFor, magpie, out, here })
    const ids = () => JSON.parse(readFileSync(join(out, "bb-memory.json"), "utf8"))
    expect(await run()).toMatchObject({ saved: 2, failed: [] })
    const was = ids()
    status[was.mem_g.id] = "superseded"
    status[was.mem_h.id] = "archived"

    list = [mem({ version: 2 }), fish({ version: 2 })]
    calls.length = 0
    expect(await run()).toMatchObject({ changed: 1, failed: [] })
    expect(calls).toEqual([["memory_save", undefined]])
    expect(ids().mem_g.id).toBe("m_0003")
    expect(ids().mem_h).toEqual({ ...was.mem_h, version: 2 })

    // bb dropping them sets neither aside: one is merged, one already aside
    status.m_0003 = "superseded"
    list = []
    calls.length = 0
    expect(await run()).toMatchObject({ forgotten: 0, failed: [] })
    expect(calls).toEqual([])
    expect(ids()).toEqual({})
    rmSync(out, { recursive: true, force: true })
  })

  test("magpie status is read from the memory file's front matter", () => {
    const memoryDir = mkdtempSync(join(tmpdir(), "getbb-magpie-"))
    writeFileSync(join(memoryDir, "m_0abc.md"), "---\nkind: fact\nstatus: superseded\nsupersededBy: m_0def\n---\nstatus: active\n")
    const magpie = makeMagpie({ bin: null, memoryDir })
    expect(magpie.status("m_0abc")).toBe("superseded")
    expect(magpie.status("m_0def")).toBeNull()
    expect(magpie.status("../m_0abc")).toBeNull()
    rmSync(memoryDir, { recursive: true, force: true })
  })

  test("a list bb cut short, or magpie refusing, is reported and tried again", async () => {
    const out = mkdtempSync(join(tmpdir(), "getbb-mem-"))
    let total = 150
    const bbFor = () => ({
      run: async (args) => (args[0] === "project" ? [] : args[1] === "get" ? { memory: {} } : { memories: [mem()], total }),
    })
    let refuse = true
    const magpie = { tool: async () => (refuse ? Promise.reject(new Error("magpie isn't running")) : "Remembered: [m_00ff] …") }
    expect((await importMemories({ bbFor, magpie, out, here })).failed).toEqual(["global: 150 memories, only the first 1 read", "mem_g: magpie isn't running"])
    refuse = false
    total = 1
    expect(await importMemories({ bbFor, magpie, out, here })).toMatchObject({ saved: 1, failed: [] })
    rmSync(out, { recursive: true, force: true })
  })

  test("magpie tool gets each parameter as --name=value, a list once per item, from the home folder", async () => {
    const bin = join(dir, "magpie")
    writeFileSync(
      bin,
      `#!/bin/sh
pwd > "${dir}/magpie-args"
printf '%s\\n' "$@" >> "${dir}/magpie-args"
case "$2" in
  memory_save) echo '{"content":[{"type":"text","text":"Remembered: [m_abc] fact"}],"isError":false}' ;;
  *) echo '{"content":[{"type":"text","text":"no memory with that id"}],"isError":true}' ; exit 1 ;;
esac
`,
    )
    chmodSync(bin, 0o755)
    const magpie = makeMagpie({ bin })
    expect(await magpie.tool("memory_save", { text: "--looks like a flag", kind: "fact", project: null, tags: ["a", "bb"], why: "" })).toBe("Remembered: [m_abc] fact")
    const [cwd, ...args] = readFileSync(join(dir, "magpie-args"), "utf8").trim().split("\n")
    expect(realpathSync(cwd)).toBe(realpathSync(homedir()))
    expect(args).toEqual(["tool", "memory_save", "--text=--looks like a flag", "--kind=fact", "--tags=a", "--tags=bb", "--json"])
    expect((await magpie.tool("memory_forget", { id: "m_x" }).catch((e) => e)).message).toBe("no memory with that id")
    expect((await makeMagpie({ bin: null }).tool("memory_save", {}).catch((e) => e)).message).toContain("isn't installed")
  })
})

test("the host part is magpie's {id, server}", () => {
  expect(plugin.id).toBe("getbb")
  expect(typeof plugin.server).toBe("function")
})
