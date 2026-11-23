#!/usr/bin/env node
// node import.mjs [folder]: writes every bb thread as a session magpie lists,
// into folder/projects (default ~/.claude-bb). Prints one line of counts when
// it wrote something or a thread failed, and nothing otherwise, so a daily
// bb automation stays quiet on a day with no new threads.
import { importThreads } from "./lib/import.mjs"
import { makeBb } from "./lib/bb.mjs"

const out = process.argv[2]
try {
  const counts = await importThreads({ bb: makeBb({ timeoutMs: 120_000 }), out })
  if (counts.written || counts.failed.length) console.log(JSON.stringify(counts))
  process.exitCode = counts.failed.length ? 1 : 0
} catch (e) {
  console.error(`bb import: ${e.message}`)
  process.exitCode = 1
}
