// The host part of the plugin: magpie's Bun host loads it and asks it for
// the page's service, a small HTTP server on 127.0.0.1 that runs the bb CLI.
// It runs inside that host, so it stops when magpie stops the plugin.
import { makeBb } from "./lib/bb.mjs"
import { startServer } from "./lib/server.mjs"

const DEFAULT_PORT = 3498
const RETRY_EVERY = 5_000
// An updated plugin starts in a new host while the old one keeps the port
// for up to ten minutes, so a busy port is retried in the background for a
// little longer than that instead of failing the start.
const RETRY_FOR = 11 * 60_000

let started = null

function start(options) {
  const port = Number(options?.port)
  const config = {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    bb: makeBb({ bbPath: typeof options?.bbPath === "string" ? options.bbPath.trim() : "" }),
  }
  const until = Date.now() + RETRY_FOR
  const attempt = () =>
    startServer(config).catch((error) => {
      if (error?.code !== "EADDRINUSE" || Date.now() > until) throw error
      return sleep(RETRY_EVERY).then(attempt)
    })
  const running = attempt()
  // A start that gave up is tried again on magpie's next server() call.
  running.catch(() => {
    started = null
  })
  // server() answers once the first bind is settled; a busy port keeps
  // retrying behind it, and the page shows its Retry button meanwhile.
  return Promise.race([running, sleep(1_000)])
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export default {
  id: "getbb",
  server: async (_input, options) => {
    if (!started) started = start(options)
    await started
    return {}
  },
}
