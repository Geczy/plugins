// bb's own memories (`bb memory`) in magpie's Memory. magpie never reads an
// agent's memory files: Claude Code and Codex add to Memory through magpie's
// memory_save tool, which keeps a memory as the agent's and gives it to every
// agent at once. Each bb memory is saved the same way, through
// `magpie tool memory_save`, and kept in step with bb.
import { execFile } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { writeAtomic } from "./import.mjs"

// Raised when what a memory is saved as changes, so every one is saved again once.
const FORMAT = 1
const LIMIT = 100
// bb's one kind magpie lacks; fact, preference, procedure, episode and
// reference are magpie's too.
const KINDS = { decision: "episode" }
const MAGPIE_KINDS = new Set(["profile", "preference", "rule", "reference", "fact", "procedure", "episode"])
const GONE = /no memory with that id/i

const isFile = (p) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export function findMagpie(env = process.env) {
  const name = process.platform === "win32" ? "magpie.exe" : "magpie"
  const dirs = [...String(env.PATH || "").split(delimiter).filter(Boolean), join(homedir(), ".local", "bin")]
  return [...dirs.map((d) => join(d, name)), "/Applications/magpie.app/Contents/MacOS/magpie"].find(isFile) || null
}

// `magpie tool <name> --<param>=<value>… --json` through the running magpie,
// as an agent's MCP call is. Resolves with the tool's text, rejects with it
// when the tool says it failed. It runs in the home folder, the folder magpie
// records the memory came from.
export function makeMagpie({ bin = findMagpie(), timeoutMs = 120_000 } = {}) {
  return {
    tool(name, params) {
      if (!bin) return Promise.reject(new Error("magpie isn't installed on PATH, in ~/.local/bin or in /Applications"))
      const args = Object.entries(params).flatMap(([k, v]) => (v == null || v === "" ? [] : [v].flat().map((x) => `--${k}=${x}`)))
      return new Promise((resolve, reject) => {
        execFile(bin, ["tool", name, ...args, "--json"], { cwd: homedir(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
          let out
          try {
            out = JSON.parse(stdout)
          } catch {}
          const text = (out?.content || []).map((c) => c.text || "").join("\n").trim()
          if (out && !out.isError && text) return resolve(text)
          reject(new Error(text || String(stderr || "").trim().split("\n").pop() || err?.message || `magpie tool ${name} printed nothing`))
        })
      })
    },
  }
}

// bb reads one project's memories in that project: BB_PROJECT_ID names it,
// and the thread's own project, which would win, is taken away.
export function projectEnv(projectId, env = process.env) {
  if (!projectId) return env
  const out = { ...env, BB_PROJECT_ID: projectId }
  delete out.BB_THREAD_ID
  delete out.BB_ENVIRONMENT_ID
  return out
}

// What memory_save is given for a bb memory. A project memory belongs to the
// project's folder on this computer; one from Personal, or from a project
// with no folder here, holds everywhere. The text is bb's summary and how to
// read the whole record, so the details stay out of magpie's digest.
export function toMemory(m, project, full = {}, here = existsSync) {
  const dirs = m.scope === "project" ? (project?.sources || []).filter((s) => s.type === "local_path" && s.path && here(s.path)) : []
  const dir = dirs.find((s) => s.isDefault) || dirs[0]
  const get = m.scope === "project" && project ? `BB_PROJECT_ID=${project.id} bb memory get ${m.id}` : `bb memory get ${m.id}`
  const kind = KINDS[m.kind] || m.kind
  return {
    text: `${m.summary || m.name}\nFull record: ${get}`,
    kind: MAGPIE_KINDS.has(kind) ? kind : null,
    scope: dir ? "project" : "global",
    project: dir?.path || null,
    tags: [...new Set([...(m.tags || []), "bb"])],
    why: full.writeReason || null,
  }
}

const idOf = (reply) => /\[(m_[0-9a-f]+)\]/.exec(reply)?.[1]

// Brings magpie's Memory up to date with bb: every global memory and every
// project's. A memory is saved again only when bb's version of it changed,
// into the magpie memory it became; one bb no longer has is set aside in
// magpie, which happens only when every list was read whole.
// out/bb-memory.json remembers which magpie memory each became.
export async function importMemories({ bbFor, magpie, out = join(homedir(), ".claude-bb"), here = existsSync, workers = 4 }) {
  const stateFile = join(out, "bb-memory.json")
  let state = {}
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"))
  } catch {}
  const counts = { memories: 0, saved: 0, changed: 0, forgotten: 0, failed: [] }
  const found = new Map()
  let whole = true
  const read = async (project) => {
    const name = project?.id || "global"
    try {
      const c = await bbFor(project?.id).run(["memory", "catalog", "--scope", project ? "project" : "global", "--limit", String(LIMIT)])
      const list = c.memories || []
      if (c.total > list.length) {
        whole = false
        counts.failed.push(`${name}: ${c.total} memories, only the first ${list.length} read`)
      }
      for (const m of list) found.set(m.id, { m, project })
    } catch (e) {
      whole = false
      counts.failed.push(`${name}: ${e.message}`)
    }
  }
  const projects = await bbFor(null).run(["project", "list", "--include-personal"])
  const queue = [null, ...projects]
  await Promise.all(Array.from({ length: workers }, async () => {
    while (queue.length) await read(queue.shift())
  }))
  counts.memories = found.size

  for (const { m, project } of found.values()) {
    const was = state[m.id]
    if (was && was.version === m.version && was.format === FORMAT) continue
    try {
      const full = (await bbFor(project?.id).run(["memory", "get", m.id])).memory || {}
      const params = toMemory(m, project, full, here)
      let reply
      if (was?.id) {
        try {
          reply = await magpie.tool("memory_save", { ...params, id: was.id })
        } catch (e) {
          if (!GONE.test(e.message)) throw e
        }
      }
      reply ??= await magpie.tool("memory_save", params)
      const id = idOf(reply)
      if (!id) throw new Error(`magpie answered: ${reply}`)
      counts[was ? "changed" : "saved"]++
      // magpie merges a save into a memory it already had ("Already
      // remembered, merged: [m_…]"), maybe the user's or another agent's.
      // Only a memory this saved ("Remembered:") or changed is ever changed
      // or set aside from here.
      const mine = id === was?.id || reply.startsWith("Remembered:")
      state[m.id] = { format: FORMAT, version: m.version, id: mine ? id : null }
    } catch (e) {
      counts.failed.push(`${m.id}: ${e.message}`)
    }
  }

  if (whole) {
    for (const [bbId, was] of Object.entries(state)) {
      if (found.has(bbId)) continue
      try {
        if (was.id) {
          await magpie.tool("memory_forget", { id: was.id }).catch((e) => {
            if (!GONE.test(e.message)) throw e
          })
          counts.forgotten++
        }
        delete state[bbId]
      } catch (e) {
        counts.failed.push(`${bbId}: ${e.message}`)
      }
    }
  }
  writeAtomic(stateFile, JSON.stringify(state))
  return counts
}
