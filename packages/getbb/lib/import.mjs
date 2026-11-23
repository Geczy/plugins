// Every bb thread, from every machine, as a Claude Code session file, so
// magpie's Sessions page lists it and Memory can learn from it. magpie reads
// any ~/.claude* folder that has a projects/ folder (appdir.ClaudeHomesIn);
// Claude Code itself reads only ~/.claude, so its /resume never sees these.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, sep } from "node:path"

const PAGE = 1000
// Raised when what a file holds changes, so every thread is written again once.
const FORMAT = 3

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

// What Memory reads: what the user typed and what the agent answered.
// Tool calls, diffs, messages from other threads and prompts programs wrote
// are left out, so Memory never takes them for the user's own words.
export function turnsOf(events, thread = {}) {
  const turns = []
  for (const e of events) {
    const d = e.data || {}
    if (e.type === "client/turn/requested" && d.initiator === "user") {
      const text = (d.input || []).filter((i) => i.type === "text").map((i) => i.text).join("\n\n").trim()
      if (text && !byProgram(d, text, thread)) turns.push({ role: "user", text, at: e.createdAt, key: e.id })
    } else if (e.type === "item/completed" && d.item?.type === "agentMessage" && d.item.text?.trim()) {
      turns.push({ role: "assistant", text: d.item.text.trim(), at: e.createdAt, key: e.id })
    }
  }
  return turns
}

// The agent's own session id, which names its file on the machine it ran on.
export function providerIdOf(events) {
  return events.find((e) => e.type === "thread/identity" && e.data?.providerThreadId)?.data.providerThreadId || null
}

// The session file for a thread: its folder under projects/, its name and
// its lines. null when the thread has nothing anyone wrote.
export function toSession(thread, events) {
  const turns = turnsOf(events, thread)
  if (!turns.length) return null
  const sessionId = uuidOf(thread.id)
  const cwd = thread.environmentPath || "/"
  let parent = null
  const lines = turns.map((t) => {
    const uuid = uuidOf(`${thread.id}:${t.key}`)
    const base = { parentUuid: parent, isSidechain: false, userType: "external", cwd, sessionId, version: "bb-import", gitBranch: thread.environmentBranchName || "", type: t.role, uuid, timestamp: new Date(t.at).toISOString() }
    parent = uuid
    return t.role === "user"
      ? { ...base, message: { role: "user", content: t.text } }
      : { ...base, message: { id: `msg_${uuid.replaceAll("-", "")}`, type: "message", role: "assistant", model: "bb-import", content: [{ type: "text", text: t.text }] } }
  })
  const title = { type: "summary", summary: thread.title || thread.titleFallback || thread.id }
  return {
    dir: cwd.replace(/[^A-Za-z0-9]/g, "-"),
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
// ~/.codex/sessions. A thread that ran here is left to these.
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
  return found
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

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
}

// Brings out/projects up to date with bb: every thread, archived and hidden
// ones too. A thread is fetched again only when bb says it changed or its
// file is gone. out/bb-import.json remembers what each thread became. A file
// this wrote earlier goes when its thread now has a native session, nothing
// left to keep, or another folder.
export async function importThreads({ bb, out = join(homedir(), ".claude-bb"), native = nativeSessions(), workers = 4 }) {
  const stateFile = join(out, "bb-import.json")
  const ours = join(out, "projects") + sep
  let state = {}
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"))
  } catch {}
  const threads = await bb.run(["thread", "list", "--include-archived", "--include-hidden"])
  const due = threads.filter((t) => {
    const was = state[t.id]
    return !was || was.format !== FORMAT || was.updatedAt !== t.updatedAt || (was.path && !existsSync(was.path))
  })
  const counts = { threads: threads.length, written: 0, native: 0, empty: 0, failed: [] }
  const queue = [...due]
  const work = async () => {
    for (let t; (t = queue.shift()); ) {
      try {
        const events = await eventsOf(bb, t.id)
        const own = native.get(providerIdOf(events))
        const s = own ? null : toSession(t, events)
        const path = own || (s && join(out, "projects", s.dir, s.name))
        if (s) writeAtomic(path, s.text)
        const was = state[t.id]?.path
        if (was && was !== path && was.startsWith(ours)) rmSync(was, { force: true })
        counts[own ? "native" : s ? "written" : "empty"]++
        state[t.id] = { format: FORMAT, updatedAt: t.updatedAt, path: path || null }
      } catch (e) {
        counts.failed.push(`${t.id}: ${e.message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, work))
  writeAtomic(stateFile, JSON.stringify(state))
  return counts
}
