// The bb CLI (getbb.app), run with --json. Every bb command prints one JSON
// value on stdout, or {ok: false, error: {code, message}} and a non-zero
// exit (`bb guide json`), so nothing here scrapes text.
import { execFile } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

const win = process.platform === "win32"
const NAMES = win ? ["bb.exe", "bb.cmd", "bb"] : ["bb"]

const isFile = (p) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// Where bb is: the bbPath option when set (and nowhere else), else
// BB_CLI, PATH, then the folders bb's installer and Homebrew use. magpie
// opened from the Dock has a short PATH, hence the fixed folders.
export function findBb(bbPath, env = process.env) {
  if (bbPath) return isFile(bbPath) ? bbPath : null
  const dirs = [...String(env.PATH || "").split(delimiter), join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]
  const tries = [env.BB_CLI, ...dirs.filter(Boolean).flatMap((d) => NAMES.map((n) => join(d, n)))]
  return tries.find((p) => p && isFile(p)) || null
}

const lsof = (args) =>
  new Promise((resolve) => {
    const bin = ["/usr/sbin/lsof", "/usr/bin/lsof"].find(isFile)
    if (!bin) return resolve("")
    execFile(bin, args, { timeout: 5_000, windowsHide: true }, (_err, stdout) => resolve(String(stdout || "")))
  })

// Outside bb (magpie opened from the Dock), a bb server on another machine
// is reached the way bb's own threads reach it: through this computer's bb
// host daemon, which runs a loopback proxy that adds the computer's
// credentials, with the bb build beside the daemon (a thread's BB_CLI). bb
// records neither: each ~/.bb-machines/<server> folder holds only the
// daemon's own API port, so the proxy is among the other loopback ports
// that process listens on. That bb starts with `#!/usr/bin/env node`, and
// the Dock's PATH has no node, so it's run with the node the daemon runs
// on. These are the candidates, each a command and a server URL still to
// be tried.
export async function daemonClients(home = homedir(), sh = lsof) {
  const found = []
  const root = join(home, ".bb-machines")
  let names = []
  try {
    names = readdirSync(root)
  } catch {}
  for (const name of names) {
    const dir = join(root, name)
    const bin = join(dir, "npm", "lib", "node_modules", "bb-app", "host-daemon", "dist", "bb")
    let port
    try {
      port = readFileSync(join(dir, "host-daemon-port"), "utf8").trim()
    } catch {
      continue
    }
    if (!/^\d+$/.test(port) || !isFile(bin)) continue
    const pids = (await sh(["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"])).split("\n").filter((p) => /^\d+$/.test(p))
    if (!pids.length) continue
    // the process's own program is the first file lsof lists as its text
    const node = /^n(\/.+)$/m.exec(await sh(["-nP", "-a", "-p", pids[0], "-d", "txt", "-Fn"]))?.[1]
    const cmd = node && isFile(node) ? [node, bin] : [bin]
    const out = await sh(["-nP", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN", "-Fn"])
    for (const [, host, p] of out.matchAll(/^n(127\.0\.0\.1|\[::1\]|localhost):(\d+)$/gm)) if (p !== port) found.push({ cmd, url: `http://${host}:${p}` })
  }
  return found
}

export class BbError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function makeBb({ bbPath = "", env = process.env, timeoutMs = 15_000, viaDaemon = daemonClients } = {}) {
  function plain(args) {
    const bin = findBb(bbPath, env)
    if (!bin) {
      const where = bbPath ? `at ${bbPath} (the bbPath option)` : "on PATH, in ~/.local/bin or in BB_CLI"
      return Promise.reject(new BbError("bb_not_found", `bb isn't installed ${where}. Install it from getbb.app, or set bbPath in this plugin's options.`))
    }
    return exec([bin], args, env)
  }

  // Outside bb, the daemon's bb and proxy that answered, kept until a
  // command through them fails (the daemon restarted on another port).
  let via = null
  async function find() {
    for (const c of await viaDaemon()) {
      const runEnv = { ...env, BB_SERVER_URL: c.url }
      if (await exec(c.cmd, ["project", "list", "--include-personal"], runEnv).then(() => true, () => false)) return { cmd: c.cmd, env: runEnv }
    }
    return null
  }

  async function run(args) {
    if (bbPath || env.BB_SERVER_URL) return plain(args)
    via ??= find()
    const v = await via
    if (!v) {
      via = null
      return plain(args)
    }
    return exec(v.cmd, args, v.env).catch((e) => {
      via = null
      throw e
    })
  }

  // cmd: bb, or the program that runs it and bb
  function exec([bin, ...pre], args, env) {
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        [...pre, ...args, "--json"],
        { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, shell: win && /\.cmd$/i.test(bin) },
        (err, stdout, stderr) => {
          let out
          try {
            out = JSON.parse(stdout)
          } catch {
            out = undefined
          }
          if (out && out.ok === false && out.error) return reject(new BbError(out.error.code || "error", out.error.message || "bb failed"))
          if (err) {
            const msg = String(stderr || "").trim().split("\n").pop() || err.message
            return reject(new BbError(err.killed ? "timeout" : "bb_failed", `bb ${args.join(" ")}: ${msg}`))
          }
          if (out === undefined) return reject(new BbError("bad_output", `bb ${args.join(" ")} printed no JSON`))
          resolve(out)
        },
      )
    })
  }

  return {
    run,
    // What the page draws: threads that aren't archived or hidden, the
    // projects they're in and the machines bb runs them on.
    async snapshot() {
      const [threads, projects, machines] = await Promise.all([
        run(["thread", "list"]),
        run(["project", "list", "--include-personal"]),
        run(["machine", "list"]),
      ])
      return {
        at: Date.now(),
        threads: (Array.isArray(threads) ? threads : []).map(slimThread),
        projects: (Array.isArray(projects) ? projects : []).map((p) => ({ id: p.id, name: p.name || p.id })),
        machines: (Array.isArray(machines) ? machines : []).map((m) => ({ id: m.id, name: m.name || m.id, status: m.status || "" })),
      }
    },
    // Opens the thread in every bb window connected to this bb.
    async open(id) {
      if (!THREAD_ID.test(String(id))) throw new BbError("invalid_value", "not a thread id")
      await run(["thread", "open", id])
      return { ok: true }
    },
  }
}

export const THREAD_ID = /^thr_[A-Za-z0-9_-]{1,64}$/

// Only what the page shows, so a thread's other fields never leave here.
export function slimThread(t) {
  return {
    id: t.id,
    projectId: t.projectId || null,
    parentThreadId: t.parentThreadId || null,
    title: t.title || t.titleFallback || null,
    status: t.runtime?.displayStatus || t.status || "idle",
    needsYou: !!t.hasPendingInteraction,
    queued: t.queuedWork && t.queuedWork !== "none" ? t.queuedWork : null,
    providerId: t.providerId || null,
    branch: t.environmentBranchName || null,
    pinned: !!t.pinnedAt,
    updatedAt: Number(t.updatedAt) || 0,
  }
}
