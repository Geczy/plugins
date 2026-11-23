// Every bb thread, from every machine, as a session file magpie reads, so its
// Sessions page lists it and Memory can learn from it: the agent's own file
// from the machine it ran on where bb can read it, else a Claude Code session
// made from the thread. magpie reads any ~/.claude* folder that has a
// projects/ folder (appdir.ClaudeHomesIn) and any ~/.codex* Codex home;
// Claude Code and Codex themselves read only ~/.claude and ~/.codex, so their
// own resume never sees these.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, sep } from "node:path"

const PAGE = 1000
// Raised when what a file holds, or which threads get one, changes, so every
// thread is written again once.
const FORMAT = 5

// A stable UUID (v5-shaped) from a string, so a re-import rewrites the same file.
export function uuidOf(s) {
  const h = createHash("sha1").update(s).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// bb marks some turns as the user's although a program wrote them: a plugin's
// prompt (the advisor's review brief, an automation's prompt) names the plugin
// in originPluginId, an automation's prompt starts "[bb automation due:" even
// where it doesn't (into a thread it re-prompts, or from an older bb), and a
// child thread opens with its parent agent's prompt. A provider plugin's turn
// is the user's answer to the agent's question.
const byProgram = (d, text, thread) =>
  (d.originPluginId && !d.originPluginId.startsWith("provider-")) || text.startsWith("[bb automation due:") || (thread.parentThreadId && d.source === "spawn")

// What Memory reads: what the user typed and what the agent answered, each
// answer with the model bb ran its turn with. Tool calls, diffs, messages
// from other threads and prompts programs wrote are left out, so Memory
// never takes them for the user's own words.
export function turnsOf(events, thread = {}) {
  const turns = []
  let model
  for (const e of events) {
    const d = e.data || {}
    if (e.type === "client/turn/requested") model = d.execution?.model || model
    if (e.type === "client/turn/requested" && d.initiator === "user") {
      const text = (d.input || []).filter((i) => i.type === "text").map((i) => i.text).join("\n\n").trim()
      if (text && !byProgram(d, text, thread)) turns.push({ role: "user", text, at: e.createdAt, key: e.id })
    } else if (e.type === "item/completed" && d.item?.type === "agentMessage" && d.item.text?.trim()) {
      turns.push({ role: "assistant", text: d.item.text.trim(), at: e.createdAt, key: e.id, model })
    }
  }
  return turns
}

// The agent's own session id, which names its file on the machine it ran on.
export function providerIdOf(events) {
  return events.find((e) => e.type === "thread/identity" && e.data?.providerThreadId)?.data.providerThreadId || null
}

// A project's folders on this computer, its default one first.
export function foldersHere(project, here = existsSync) {
  const dirs = (project?.sources || []).filter((s) => s.type === "local_path" && s.path && here(s.path))
  return [...dirs.filter((s) => s.isDefault), ...dirs.filter((s) => !s.isDefault)].map((s) => s.path)
}

// The folder a thread's session is filed under, which is the project magpie
// learns it for: the folder the thread ran in when that is one of its
// project's folders on this computer, else the project's folder here, else
// the home folder (Personal, and a project with no folder here).
export function folderOf(thread, project, here = existsSync, home = homedir()) {
  const dirs = foldersHere(project, here)
  const ran = thread.environmentPath
  if (ran && dirs.some((d) => ran === d || ran.startsWith(d + sep))) return ran
  return dirs[0] || home
}

const dirOf = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-")

// The session file for a thread, filed under cwd: its folder under
// projects/, its name and its lines. null when the thread has nothing
// anyone wrote.
export function toSession(thread, events, cwd = thread.environmentPath || "/") {
  const turns = turnsOf(events, thread)
  if (!turns.length) return null
  const sessionId = uuidOf(thread.id)
  let parent = null
  const lines = turns.map((t) => {
    const uuid = uuidOf(`${thread.id}:${t.key}`)
    const base = { parentUuid: parent, isSidechain: false, userType: "external", cwd, sessionId, version: "bb-import", gitBranch: thread.environmentBranchName || "", type: t.role, uuid, timestamp: new Date(t.at).toISOString() }
    parent = uuid
    return t.role === "user"
      ? { ...base, message: { role: "user", content: t.text } }
      : { ...base, message: { id: `msg_${uuid.replaceAll("-", "")}`, type: "message", role: "assistant", model: t.model || "bb-import", content: [{ type: "text", text: t.text }] } }
  })
  const title = { type: "summary", summary: thread.title || thread.titleFallback || thread.id }
  return {
    dir: dirOf(cwd),
    name: `${sessionId}.jsonl`,
    text: [title, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n",
  }
}

const list = (d) => {
  try {
    return readdirSync(d, { withFileTypes: true })
  } catch {
    return []
  }
}

// Session files magpie already reads on this computer, by the agent's own
// id: Claude Code's under ~/.claude/projects, Codex's rollouts under
// ~/.codex/sessions and, once archived, ~/.codex/archived_sessions. A
// thread that ran here is left to these.
export function nativeSessions(home = homedir()) {
  const found = new Map()
  const claude = join(home, ".claude", "projects")
  for (const d of list(claude)) for (const f of list(join(claude, d.name))) if (f.name.endsWith(".jsonl")) found.set(f.name.slice(0, -6), join(claude, d.name, f.name))
  const walk = (dir) => {
    for (const f of list(dir)) {
      if (f.isDirectory()) walk(join(dir, f.name))
      const m = f.isFile() && /-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/.exec(f.name)
      if (m) found.set(m[1], join(dir, f.name))
    }
  }
  walk(join(home, ".codex", "sessions"))
  walk(join(home, ".codex", "archived_sessions"))
  return found
}

// The home folder on a machine, from a folder a thread ran in there: the one
// that holds bb's .bb-machines folder, else /home/<user>, /Users/<user> or
// /root. null when the folder says nothing about it.
export function homeOf(path) {
  const p = String(path || "")
  return (/^(.+?)\/\.bb-machines\//.exec(p) || /^(\/(?:home|Users)\/[^/]+|\/root)(?:\/|$)/.exec(p))?.[1] || null
}

// This computer's machine ids, one per bb server it's enrolled with.
export function hostsHere(home = homedir()) {
  const ids = new Set()
  for (const d of list(join(home, ".bb-machines"))) {
    try {
      const id = readFileSync(join(home, ".bb-machines", d.name, "host-id"), "utf8").trim()
      if (id) ids.add(id)
    } catch {}
  }
  return ids
}

// A session file from another machine, filed under cwd on this computer:
// the folder each line names is cwd (Claude Code's on every line, Codex's on
// its session_meta and turn_context lines). Every other line is kept as the
// agent wrote it.
export function refiled(text, cwd) {
  return text
    .split("\n")
    .map((line) => {
      let o
      try {
        o = JSON.parse(line)
      } catch {
        return line
      }
      if (typeof o?.cwd === "string") o.cwd = cwd
      else if ((o?.type === "session_meta" || o?.type === "turn_context") && typeof o.payload?.cwd === "string") o.payload.cwd = cwd
      else return line
      return JSON.stringify(o)
    })
    .join("\n")
}

// The session files on a machine bb can reach, by the agent's own id, read
// with bb's file commands: Claude Code's with their subagents' files, and
// Codex's rollouts, archived ones too. A compressed rollout (.jsonl.zst)
// isn't one, since magpie can't read it.
export async function sessionsOn(bb, host, home) {
  const found = new Map()
  const ls = async (dir) => (await bb.run(["file", "list", "--host", host, dir, "--limit", "10000"])).files.map((f) => f.path)
  const claude = `${home}/.claude/projects`
  const subagents = []
  for (const p of await ls(claude)) {
    let m
    if ((m = /^[^/]+\/([^/]+)\.jsonl$/.exec(p))) found.set(m[1], { kind: "claude", path: `${claude}/${p}`, subagents: [] })
    else if ((m = /^[^/]+\/([^/]+)\/subagents\/([^/]+\.jsonl)$/.exec(p))) subagents.push([m[1], { name: m[2], path: `${claude}/${p}` }])
  }
  for (const [id, a] of subagents) found.get(id)?.subagents.push(a)
  for (const root of [`${home}/.codex/sessions`, `${home}/.codex/archived_sessions`]) {
    for (const p of await ls(root)) {
      const m = /(?:^|\/)(rollout-(\d{4})-(\d\d)-(\d\d)T[^/]*-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl)$/.exec(p)
      if (m) found.set(m[5], { kind: "codex", path: `${root}/${p}`, name: m[1], day: [m[2], m[3], m[4]] })
    }
  }
  return found
}

// A file on another machine, checked against the digest bb sends with it.
async function readFar(bb, host, path) {
  const f = await bb.run(["file", "read", "--host", host, path])
  if (f?.contentEncoding !== "utf8" || createHash("sha256").update(f.content).digest("hex") !== f.sha256) throw new Error(`${path} on ${host} didn't arrive whole`)
  return f.content
}

async function eventsOf(bb, id) {
  const kept = []
  for (let after = 0; ; ) {
    const page = await bb.run(["thread", "messages", id, "--limit", String(PAGE), "--after-seq", String(after)])
    for (const e of page) if (e.type === "thread/identity" || e.type === "client/turn/requested" || e.type === "item/completed") kept.push(e)
    if (page.length < PAGE) return kept
    after = page[page.length - 1].seq
  }
}

export function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
}

// Brings out/projects (and codexOut/sessions) up to date with bb: every
// thread, archived and hidden ones too. A thread that ran on another machine
// gets its agent's own session file from there when bb can read it (copied),
// which carries the real models and token counts magpie prices; otherwise,
// or when it ran here, a session made from the thread (written). A thread is
// fetched again only when bb says it changed, its file is gone, it now
// belongs in another folder, or its machine was offline last time.
// out/bb-import.json remembers what each thread became. A file this wrote
// earlier goes when its thread now has a native session, nothing left to
// keep, or another file.
export async function importThreads({ bb, out = join(homedir(), ".claude-bb"), codexOut = join(homedir(), ".codex-bb"), native = nativeSessions(), hereHosts = hostsHere(), workers = 4, here = existsSync, home = homedir() }) {
  const stateFile = join(out, "bb-import.json")
  const ours = (p) => !!p && [join(out, "projects"), join(codexOut, "sessions")].some((d) => p.startsWith(d + sep))
  let state = {}
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"))
  } catch {}
  const threads = await bb.run(["thread", "list", "--include-archived", "--include-hidden"])
  const projects = new Map((await bb.run(["project", "list", "--include-personal"])).map((p) => [p.id, p]))
  const cwd = new Map(threads.map((t) => [t.id, folderOf(t, projects.get(t.projectId), here, home)]))
  const due = threads.filter((t) => {
    const was = state[t.id]
    const moved = ours(was?.path) && was.cwd !== cwd.get(t.id)
    return !was || was.format !== FORMAT || was.updatedAt !== t.updatedAt || (was.path && !existsSync(was.path)) || moved || was.waits
  })
  const counts = { threads: threads.length, written: 0, copied: 0, native: 0, empty: 0, failed: [] }

  // Each machine's home folder, from the folders its threads ran in, and the
  // session files on it, listed once a run and only when a thread needs them.
  const homes = new Map()
  for (const t of threads) if (t.environmentHostId && !homes.get(t.environmentHostId)) homes.set(t.environmentHostId, homeOf(t.environmentPath))
  let machines
  const far = new Map()
  const filesOn = (host) => {
    if (!far.has(host))
      far.set(
        host,
        (async () => {
          machines ??= bb.run(["machine", "list"])
          const m = (await machines).find((m) => m.id === host)
          if (!m || !homes.get(host)) return { files: new Map() }
          // offline: a copy of the thread for now, its own file next time
          if (m.status !== "connected") return { files: new Map(), waits: true }
          try {
            return { files: await sessionsOn(bb, host, homes.get(host)) }
          } catch (e) {
            counts.failed.push(`${host}: ${e.message}`)
            return { files: new Map(), waits: true }
          }
        })(),
      )
    return far.get(host)
  }
  // Reads every file before writing any, so a failed read leaves the last copy.
  const copy = async (host, s, folder) => {
    if (s.kind === "codex") {
      const path = join(codexOut, "sessions", ...s.day, s.name)
      writeAtomic(path, refiled(await readFar(bb, host, s.path), folder))
      return path
    }
    const dir = join(out, "projects", dirOf(folder))
    const id = basename(s.path, ".jsonl")
    const files = [[join(dir, `${id}.jsonl`), s.path], ...s.subagents.map((a) => [join(dir, id, "subagents", a.name), a.path])]
    const texts = []
    for (const [, from] of files) texts.push(refiled(await readFar(bb, host, from), folder))
    files.forEach(([to], i) => writeAtomic(to, texts[i]))
    return files[0][0]
  }

  const queue = [...due]
  const work = async () => {
    for (let t; (t = queue.shift()); ) {
      try {
        const events = await eventsOf(bb, t.id)
        const id = providerIdOf(events)
        const folder = cwd.get(t.id)
        let path = native.get(id)
        let kind = path ? "native" : null
        let waits = false
        if (!kind && id && t.environmentHostId && !hereHosts.has(t.environmentHostId)) {
          const on = await filesOn(t.environmentHostId)
          waits = !!on.waits
          const s = on.files.get(id)
          // bb sends a file of at most 25 MB, and can't send part of one
          if (s) path = await copy(t.environmentHostId, s, folder).catch((e) => (e.code === "file_too_large" ? undefined : Promise.reject(e)))
          if (path) kind = "copied"
        }
        if (!kind) {
          const s = toSession(t, events, folder)
          path = s && join(out, "projects", s.dir, s.name)
          if (s) writeAtomic(path, s.text)
          kind = s ? "written" : "empty"
        }
        const was = state[t.id]?.path
        if (was && was !== path && ours(was)) {
          rmSync(was, { force: true })
          // its subagents' files, and its folder when that was the last file in it
          rmSync(was.replace(/\.jsonl$/, ""), { recursive: true, force: true })
          try {
            rmdirSync(dirname(was))
          } catch {}
        }
        counts[kind]++
        state[t.id] = { format: FORMAT, updatedAt: t.updatedAt, path: path || null, cwd: folder, ...(waits && { waits }) }
      } catch (e) {
        counts.failed.push(`${t.id}: ${e.message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, work))
  writeAtomic(stateFile, JSON.stringify(state))
  return counts
}
