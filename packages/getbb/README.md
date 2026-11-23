# bb threads

A page in magpie's window with your [bb](https://getbb.app) threads: how many are running, waiting on you or failed, every open thread grouped by project, and an **Open in bb** button that brings the thread up in your bb windows. The page follows magpie's theme and language (English and Chinese).

It reads everything from the `bb` CLI on this computer, the same commands you can run yourself:

| What the page shows | Command |
| --- | --- |
| Threads (archived and hidden ones left out) | `bb thread list --json` |
| Project names | `bb project list --include-personal --json` |
| Machines and whether they're connected | `bb machine list --json` |
| Open in bb | `bb thread open <thread-id> --json` |

## Add it

```sh
magpie plugin add <path to this folder>
```

Then open **bb threads** under Plugins in magpie's sidebar.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `port` | `3498` | The loopback port of the page's local service |
| `bbPath` | empty | Full path to the `bb` binary. When empty, the plugin tries `$BB_CLI`, then `PATH`, then `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`, since magpie started from the Dock has a short `PATH` |

## How it works

A magpie page can only navigate, so the plugin's host part (`index.mjs`) runs a small HTTP service on `127.0.0.1:<port>` inside magpie's plugin host, and the page (`page/boot.js`) hands its frame to it. The service runs the `bb` commands above, keeps a snapshot for three seconds so several open pages share one run, and passes only the fields the page draws.

The service:

- answers only on loopback, and refuses any request whose `Host` isn't `127.0.0.1`, `localhost` or `[::1]` on its port, which stops DNS-rebinding pages;
- puts a random token in the page it serves and wants it back on every API call, so another site in your browser can't read your threads or open one;
- runs `bb thread open` only for an argument shaped like a thread id (`thr_…`).

If `bb` isn't found, or a command fails, the page shows bb's own error message and a Retry button.

### A bb server on another machine

When your bb server runs somewhere else (a `<handle>.getbb.app` server you reach through bb connect), the `bb` CLI must be able to reach it from magpie's environment, the way it does from your terminal. The page shows bb's error if it can't, such as `HTTP 403: bb connect: machine not authorized`.

## Tests

```sh
bun test packages/getbb
bun scripts/check.mjs getbb
```

---

# bb 线程

在 magpie 窗口里查看 [bb](https://getbb.app) 的线程：正在运行、等你处理和出错的数量，按项目分组的所有打开的线程，以及一个**在 bb 中打开**按钮，在你的 bb 窗口里打开该线程。页面跟随 magpie 的主题和语言。

数据全部来自本机的 `bb` 命令行（`bb thread list`、`bb project list --include-personal`、`bb machine list`，打开线程用 `bb thread open`）。

选项：`port`（默认 3498）是页面本地服务的端口；`bbPath` 是 `bb` 的完整路径，留空时依次查找 `$BB_CLI`、`PATH`、`~/.local/bin`、`/opt/homebrew/bin` 和 `/usr/local/bin`。

本地服务只监听 `127.0.0.1`，拒绝 `Host` 不是本机端口的请求，每次 API 调用都要带上页面里的随机令牌，`bb thread open` 只接受形如 `thr_…` 的线程 ID。找不到 `bb` 或命令失败时，页面显示 bb 自己的错误信息和重试按钮。bb 服务器在另一台机器上时，magpie 的环境里的 `bb` 命令行要能连上它。
