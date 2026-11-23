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

## Your bb threads in magpie's Sessions and Memory

magpie's Sessions page, `magpie sessions search` and Memory's **Learn from conversations** read the sessions agents keep on this computer. A bb thread that ran on another machine isn't one of them. `import.mjs` writes every bb thread (archived and hidden ones too) as a Claude Code session in `~/.claude-bb/projects`, a folder magpie reads and Claude Code's own `/resume` doesn't:

```sh
node packages/getbb/import.mjs            # or: node import.mjs <folder> to write somewhere else
```

- Each file keeps what you typed and what the agent answered, which is all Memory reads, under the thread's title and folder. Tool calls, diffs and images stay in bb.
- bb files some prompts under you that a program wrote: a plugin's (the advisor's review brief, an automation's prompt) and the one a parent thread's agent opens a child thread with. These are left out, so Memory doesn't learn them as your rules. Your answers to an agent's questions stay.
- A thread that ran on this computer and still has its Claude Code or Codex session here is left to that session, so it isn't listed twice. magpie reads that session as the agent wrote it, plugin prompts included.
- A second run fetches only the threads bb says changed, and prints nothing when none did. `~/.claude-bb/bb-import.json` remembers what each thread became.
- Codex, Kimi and Muse threads are written as Claude Code sessions too, so magpie lists them under Claude Code.

magpie reads them once Claude Code's sessions are allowed: `magpie sessions read on claude`. `bb` must work where it runs, as it does in a bb thread or a bb terminal on this computer. To run it every day from a bb automation, use a script automation that starts it in a terminal on this computer:

```sh
bb terminal run --machine <this computer> --timeout 14m --json -- node <path>/packages/getbb/import.mjs
```

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

`node import.mjs` 把所有 bb 线程（包括已归档和隐藏的）写成 Claude Code 会话，放在 `~/.claude-bb/projects`，magpie 的会话页、`magpie sessions search` 和记忆的「从对话中学习」都能读到；需先运行 `magpie sessions read on claude`。只保留你写的和智能体回答的文字，插件或父线程智能体写的提示不算作你的话；本机已有 Claude Code 或 Codex 会话的线程不重复写入；再次运行只取有变化的线程。

本地服务只监听 `127.0.0.1`，拒绝 `Host` 不是本机端口的请求，每次 API 调用都要带上页面里的随机令牌，`bb thread open` 只接受形如 `thr_…` 的线程 ID。找不到 `bb` 或命令失败时，页面显示 bb 自己的错误信息和重试按钮。bb 服务器在另一台机器上时，magpie 的环境里的 `bb` 命令行要能连上它。
