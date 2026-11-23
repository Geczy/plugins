// The page itself: polls the service's snapshot while it is visible and
// draws it. Every string from bb goes in through textContent.
;(() => {
  const V = globalThis.GetbbView
  const $ = (id) => document.getElementById(id)
  const meta = (name) => document.querySelector(`meta[name="getbb-${name}"]`)?.content || ""
  const token = meta("token")
  const lang = document.documentElement.lang
  const T = V.text(lang)
  const POLL_MS = 10_000

  const state = { data: null, filter: "all", query: "", error: null, opened: "" }
  let timer = null
  let visible = true

  // The launcher passes magpie's theme tokens; the bridge repaints them on
  // a theme change.
  try {
    for (const [key, value] of Object.entries(JSON.parse(meta("tokens") || "{}"))) {
      if (typeof value === "string") document.documentElement.style.setProperty(`--magpie-${key}`, value)
    }
  } catch {
    // Tokens are optional; the stylesheet has its own colors.
  }

  function el(tag, cls, content) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (content !== undefined) node.textContent = content
    return node
  }

  async function api(path, init = {}) {
    const res = await fetch(path, { ...init, headers: { "x-getbb-token": token, ...(init.headers || {}) } })
    const body = await res.json().catch(() => null)
    if (!res.ok) throw Object.assign(new Error(body?.error?.message || `HTTP ${res.status}`), { code: body?.error?.code })
    return body
  }

  async function refresh() {
    clearTimeout(timer)
    try {
      state.data = await api("api/snapshot")
      state.error = null
    } catch (error) {
      state.error = error
    }
    render()
    if (visible) timer = setTimeout(refresh, POLL_MS)
  }

  async function open(id, button) {
    button.disabled = true
    try {
      await api("api/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) })
      state.opened = id
      button.textContent = T.opened
      setTimeout(() => {
        if (state.opened === id) state.opened = ""
        render()
      }, 2500)
    } catch (error) {
      state.error = error
      render()
    } finally {
      button.disabled = false
    }
  }

  function renderMetrics(threads) {
    const counts = V.summarize(threads)
    const box = $("metrics")
    box.replaceChildren()
    for (const key of ["active", "waiting", "error", "total"]) {
      const card = el("button", `metric ${key}${state.filter === key ? " on" : ""}`)
      card.type = "button"
      card.append(el("span", "value", String(counts[key])), el("span", "label", T[key]))
      card.addEventListener("click", () => setFilter(key === "total" || state.filter === key ? "all" : key))
      box.append(card)
    }
  }

  function renderChips() {
    const box = $("chips")
    box.replaceChildren()
    for (const key of ["all", "active", "waiting", "error"]) {
      const chip = el("button", `chip${state.filter === key ? " on" : ""}`, T[key])
      chip.type = "button"
      chip.setAttribute("aria-pressed", String(state.filter === key))
      chip.addEventListener("click", () => setFilter(key))
      box.append(chip)
    }
  }

  function threadRow(t, now) {
    const status = V.statusOf(t)
    const row = el("div", `thread ${status}`)
    const dot = el("span", "dot")
    dot.title = T[status] || t.status
    const main = el("div", "main")
    const title = el("div", "name", t.title || T.untitled)
    title.title = t.title || ""
    const facts = el("div", "facts")
    for (const [fact, cls] of [[t.providerId, ""], [t.branch, "branch"], [t.parentThreadId ? T.child : null, ""], [V.ago(t.updatedAt, now, lang), ""]]) {
      if (fact) facts.append(el("span", cls, fact))
    }
    main.append(title, facts)
    const button = el("button", "open", state.opened === t.id ? T.opened : T.open)
    button.type = "button"
    button.addEventListener("click", () => open(t.id, button))
    row.append(dot, main, button)
    return row
  }

  function render() {
    const d = state.data
    const threads = d?.threads || []
    $("title").textContent = T.title
    document.title = T.title
    $("search").placeholder = T.search
    $("updated").textContent = d ? T.updated(V.ago(d.at, Date.now(), lang)) : ""
    renderMetrics(threads)
    renderChips()

    const notice = $("notice")
    if (state.error) {
      notice.hidden = false
      notice.replaceChildren(el("span", "", state.error.code === "bb_not_found" ? T.notFound : `${T.failed}: ${state.error.message}`))
      const retry = el("button", "retry", T.retry)
      retry.type = "button"
      retry.addEventListener("click", refresh)
      notice.append(retry)
    } else notice.hidden = true

    const list = $("list")
    list.replaceChildren()
    if (d) {
      const shown = V.filterThreads(threads, { filter: state.filter, query: state.query })
      if (!shown.length) list.append(el("p", "empty", threads.length ? T.empty : T.none))
      const now = Date.now()
      for (const group of V.groupByProject(shown, d.projects)) {
        const section = el("section", "project")
        const head = el("h2", "", group.name || T.personal)
        head.append(el("span", "count", String(group.threads.length)))
        section.append(head, ...group.threads.map((t) => threadRow(t, now)))
        list.append(section)
      }
    }

    const machines = $("machines")
    machines.replaceChildren()
    if (d?.machines?.length) {
      machines.append(el("span", "label", T.machines))
      for (const m of d.machines) {
        const item = el("span", `machine ${m.status === "connected" ? "up" : "down"}`, m.name)
        item.title = m.status
        machines.append(item)
      }
    }
  }

  function setFilter(key) {
    state.filter = key
    render()
  }

  $("search").addEventListener("input", (event) => {
    state.query = event.target.value
    render()
  })

  window.magpie?.onVisibility?.((now) => {
    visible = now
    if (now) refresh()
    else clearTimeout(timer)
  })
  document.addEventListener("visibilitychange", () => {
    visible = document.visibilityState === "visible"
    if (visible) refresh()
    else clearTimeout(timer)
  })

  render()
  refresh()
})()
