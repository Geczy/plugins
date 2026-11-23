// The page magpie opens can only navigate (its frame has connect-src
// 'none'), so it hands the frame to the plugin's local service, passing
// magpie's theme and language along.
(async () => {
  const DEFAULT_PORT = 3498
  const words = {
    en: {
      title: "bb threads",
      connecting: "Connecting to the local bb service…",
      stopped: (port) => `The local bb service isn't answering on 127.0.0.1:${port}. magpie may still be starting it.`,
      retry: "Retry",
    },
    zh: {
      title: "bb 线程",
      connecting: "正在连接本地 bb 服务…",
      stopped: (port) => `本地 bb 服务没有在 127.0.0.1:${port} 上响应，magpie 可能还在启动它。`,
      retry: "重试",
    },
  }

  let port = DEFAULT_PORT
  let theme = "light"
  let lang = "en"
  let tokens = null
  let service = ""

  try {
    const current = await window.magpie?.ready
    if (current) {
      theme = current.dark ? "dark" : "light"
      lang = String(current.lang || "").toLowerCase().startsWith("zh") ? "zh" : "en"
      tokens = current.tokens || null
    }
  } catch {
    // The page still works without the bridge.
  }
  try {
    const value = Number((await window.magpie?.options?.get?.())?.port)
    if (Number.isInteger(value) && value > 0 && value < 65536) port = value
  } catch {
    // The declared default port.
  }
  try {
    const value = window.magpie?.service
    if (typeof value === "string" && /^https?:\/\//.test(value)) service = value
  } catch {
    // The desktop window goes straight to loopback.
  }

  const text = words[lang]
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en"
  document.title = text.title
  document.getElementById("title").textContent = text.title
  document.getElementById("said").textContent = text.connecting
  document.getElementById("retry").textContent = text.retry

  // Through `magpie web` the service sits under a path; the UI asks for its
  // files relative to it, so the URL must end in a slash.
  const url = new URL(service || `http://127.0.0.1:${port}/`, location.href)
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  url.searchParams.set("theme", theme)
  url.searchParams.set("lang", lang)
  if (tokens && typeof tokens === "object") {
    try {
      const slim = {}
      for (const [key, value] of Object.entries(tokens)) {
        const item = String(value ?? "").trim()
        if (item && item.length <= 160) slim[key] = item
      }
      if (Object.keys(slim).length) url.searchParams.set("tokens", btoa(unescape(encodeURIComponent(JSON.stringify(slim)))))
    } catch {
      // Theme tokens are optional.
    }
  }

  const timer = setTimeout(() => {
    document.getElementById("said").textContent = text.stopped(port)
    document.getElementById("retry").hidden = false
  }, 5000)
  document.getElementById("retry").addEventListener("click", () => {
    clearTimeout(timer)
    location.reload()
  })

  location.replace(url.href)
})()
