// The bb CLI (getbb.app), run with --json. Every bb command prints one JSON
// value on stdout, or {ok: false, error: {code, message}} and a non-zero
// exit (`bb guide json`), so nothing here scrapes text.
import { execFile } from "node:child_process"
import { statSync } from "node:fs"
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

export class BbError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function makeBb({ bbPath = "", env = process.env, timeoutMs = 15_000 } = {}) {
  function run(args) {
    const bin = findBb(bbPath, env)
    if (!bin) {
      const where = bbPath ? `at ${bbPath} (the bbPath option)` : "on PATH, in ~/.local/bin or in BB_CLI"
      return Promise.reject(new BbError("bb_not_found", `bb isn't installed ${where}. Install it from getbb.app, or set bbPath in this plugin's options.`))
    }
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        [...args, "--json"],
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
