#!/usr/bin/env node
// node import.mjs [folder]: writes every bb thread as a session magpie lists,
// into folder/projects (default ~/.claude-bb), then saves every bb memory in
// magpie's Memory. Prints one line of counts when it wrote or saved something
// or something failed, and nothing otherwise, so a daily bb automation stays
// quiet on a day with nothing new.
import { importThreads } from "./lib/import.mjs"
import { importMemories, makeMagpie, projectEnv } from "./lib/memory.mjs"
import { makeBb } from "./lib/bb.mjs"

const out = process.argv[2]
try {
  const threads = await importThreads({ bb: makeBb({ timeoutMs: 120_000 }), out })
  const { failed, ...memories } = await importMemories({ bbFor: (p) => makeBb({ timeoutMs: 120_000, env: projectEnv(p) }), magpie: makeMagpie(), out })
  const counts = { ...threads, memories, failed: [...threads.failed, ...failed] }
  if (threads.written || memories.saved || memories.changed || memories.forgotten || counts.failed.length) console.log(JSON.stringify(counts))
  process.exitCode = counts.failed.length ? 1 : 0
} catch (e) {
  console.error(`bb import: ${e.message}`)
  process.exitCode = 1
}
