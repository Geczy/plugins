// What the page shows, worked out from a snapshot: no DOM and no network,
// so getbb.test.mjs runs it as it is. A classic script: the page loads it
// before app.js, which reads globalThis.GetbbView.
;(() => {
  const TEXT = {
    en: {
      title: "bb threads",
      active: "Running",
      waiting: "Needs you",
      error: "Failed",
      total: "Threads",
      all: "All",
      search: "Search threads",
      open: "Open in bb",
      opened: "Opened in bb",
      empty: "No threads match.",
      none: "bb has no open threads.",
      machines: "Machines",
      personal: "Personal",
      updated: (ago) => `Updated ${ago}`,
      notFound: "bb isn't installed where this plugin looks. Install it from getbb.app, or set bbPath in this plugin's options.",
      failed: "bb didn't answer",
      retry: "Retry",
      untitled: "Untitled thread",
      child: "subthread",
    },
    zh: {
      title: "bb 线程",
      active: "运行中",
      waiting: "等你处理",
      error: "出错",
      total: "线程",
      all: "全部",
      search: "搜索线程",
      open: "在 bb 中打开",
      opened: "已在 bb 中打开",
      empty: "没有匹配的线程。",
      none: "bb 里没有打开的线程。",
      machines: "机器",
      personal: "个人",
      updated: (ago) => `${ago}更新`,
      notFound: "在本插件查找的位置没有找到 bb。请从 getbb.app 安装，或在插件选项里设置 bbPath。",
      failed: "bb 没有响应",
      retry: "重试",
      untitled: "未命名线程",
      child: "子线程",
    },
  }

  const text = (lang) => (String(lang || "").toLowerCase().startsWith("zh") ? TEXT.zh : TEXT.en)

  // One of four: a thread waiting on a reply or approval needs you even
  // while bb shows it as running.
  function statusOf(t) {
    if (t.needsYou) return "waiting"
    const s = String(t.status || "").toLowerCase()
    if (s === "error" || s === "failed") return "error"
    if (s === "active" || s === "running" || s === "starting" || s === "queued" || t.queued) return "active"
    return "idle"
  }

  function summarize(threads) {
    const out = { active: 0, waiting: 0, error: 0, total: threads.length }
    for (const t of threads) {
      const s = statusOf(t)
      if (s in out) out[s] += 1
    }
    return out
  }

  function filterThreads(threads, { filter = "all", query = "" } = {}) {
    const q = String(query).trim().toLowerCase()
    return threads.filter((t) => {
      if (filter !== "all" && statusOf(t) !== filter) return false
      if (!q) return true
      return [t.title, t.branch, t.providerId, t.id].some((v) => v && String(v).toLowerCase().includes(q))
    })
  }

  const RANK = { waiting: 0, error: 1, active: 2, idle: 3 }

  // Projects in the order of their latest activity; inside one, what needs
  // attention first, then the most recently updated.
  function groupByProject(threads, projects) {
    const names = new Map((projects || []).map((p) => [p.id, p.name]))
    const groups = new Map()
    for (const t of threads) {
      const key = t.projectId || ""
      if (!groups.has(key)) groups.set(key, { id: key, name: names.get(key) || key || "", threads: [], latest: 0 })
      const g = groups.get(key)
      g.threads.push(t)
      g.latest = Math.max(g.latest, t.updatedAt || 0)
    }
    for (const g of groups.values()) {
      g.threads.sort((a, b) => RANK[statusOf(a)] - RANK[statusOf(b)] || (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0))
    }
    return [...groups.values()].sort((a, b) => b.latest - a.latest)
  }

  function ago(ms, now = Date.now(), lang = "en") {
    const s = Math.max(0, Math.round((now - ms) / 1000))
    const zh = String(lang).startsWith("zh")
    const unit = s < 60 ? [s, "s", "秒"] : s < 3600 ? [Math.floor(s / 60), "m", "分钟"] : s < 86400 ? [Math.floor(s / 3600), "h", "小时"] : [Math.floor(s / 86400), "d", "天"]
    if (s < 10) return zh ? "刚刚" : "just now"
    return zh ? `${unit[0]} ${unit[2]}前` : `${unit[0]}${unit[1]} ago`
  }

  globalThis.GetbbView = { text, statusOf, summarize, filterThreads, groupByProject, ago }
})()
