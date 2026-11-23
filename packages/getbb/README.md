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
| `bbPath` | empty | Full path to the `bb` binary, run as it is. When empty, the plugin first looks for bb's host daemon on this computer (see [A bb server on another machine](#a-bb-server-on-another-machine)), then tries `$BB_CLI`, then `PATH`, then `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`, since magpie started from the Dock has a short `PATH` |

## How it works

A magpie page can only navigate, so the plugin's host part (`index.mjs`) runs a small HTTP service on `127.0.0.1:<port>` inside magpie's plugin host, and the page (`page/boot.js`) hands its frame to it. The service runs the `bb` commands above, keeps a snapshot for three seconds so several open pages share one run, and passes only the fields the page draws.

The service:

- answers only on loopback, and refuses any request whose `Host` isn't `127.0.0.1`, `localhost` or `[::1]` on its port, which stops DNS-rebinding pages;
- puts a random token in the page it serves and wants it back on every API call, so another site in your browser can't read your threads or open one;
- runs `bb thread open` only for an argument shaped like a thread id (`thr_…`).

If `bb` isn't found, or a command fails, the page shows bb's own error message and a Retry button.

### A bb server on another machine

When your bb server runs somewhere else (a `<handle>.getbb.app` server you reach through bb connect), bb's own threads reach it through the bb host daemon on this computer. The daemon runs a loopback proxy that adds this computer's credentials, and bb hands its address (`BB_SERVER_URL`) and the bb build beside the daemon (`BB_CLI`) to its threads and terminals. magpie started from the Dock gets neither, so when `bbPath` is empty and `BB_SERVER_URL` isn't set, the plugin finds them:

- It reads the daemon's port from `~/.bb-machines/<server>/host-daemon-port`, and with `lsof` finds the process listening there, the node it runs on and the other loopback ports it listens on.
- It runs that folder's `npm/lib/node_modules/bb-app/host-daemon/dist/bb` with that node, tries each port as `BB_SERVER_URL` with `bb project list`, and keeps the first that answers.
- After a command through them fails it looks again, since the daemon listens on a new port when it restarts.

It never reads the credentials: the daemon adds them. bb documents none of this, so a bb update may change it, and the page then shows bb's error, such as `HTTP 403: bb connect: machine not authorized`. Setting `bbPath` turns the lookup off.

## Your bb threads in magpie's Sessions and Memory

magpie's Sessions page, Usage, `magpie sessions search` and Memory's **Learn from conversations** read the sessions agents keep on this computer. A bb thread that ran on another machine isn't one of them. `import.mjs` brings every bb thread (archived and hidden ones too) to this computer, into folders magpie reads and Claude Code's `/resume` and Codex's own history don't:

```sh
node packages/getbb/import.mjs            # or: node import.mjs <folder> to write into <folder>/projects and <folder>/codex
```

- A thread that ran on another machine gets its agent's own session file from there, read with `bb file list` and `bb file read --host`: a Claude Code session, with its subagents' files, into `~/.claude-bb/projects`, and a Codex rollout into `~/.codex-bb/sessions`. magpie reads it like a session from this computer, with its models, token counts and cost, and with plugin prompts and tool output as the agent wrote them. The one change is the folder it names, which becomes the thread's folder on this computer (see below). Each file is checked against the SHA-256 bb sends with it, and one that arrives changed is reported and tried again on the next run.
- Every other thread is written as a Claude Code session in `~/.claude-bb/projects`: what you typed and what the agent answered, under the thread's title, each answer naming the model bb ran its turn with. Tool calls, diffs and images stay in bb, and magpie shows its cost as $0, since bb keeps no token counts per turn. This is what becomes of a session file over the 25 MB `bb file read` sends, a compressed Codex rollout (`.jsonl.zst`), a Kimi or Muse thread and a thread from a machine bb has removed. A thread from a machine that's offline becomes one for now, and the next run tries its own file again.
- A thread is filed under its project's folder on this computer, so Memory learns it for that project: the folder it ran in when that is one of the project's folders here, else the project's folder here. Personal threads, and threads of a project with no folder here, are filed under your home folder. When a project gets a folder here later, its threads move there on the next run.
- bb files some prompts under you that a program wrote: a plugin's (the advisor's review brief, an automation's prompt) and the one a parent thread's agent opens a child thread with. A session written from a thread leaves these out, so Memory doesn't learn them as your rules, and keeps your answers to an agent's questions. A session file copied from the thread's machine has them, as one from this computer does.
- A thread that ran on this computer and still has its Claude Code or Codex session here is left to that session, so it isn't listed twice.
- A second run fetches only the threads bb says changed and those whose machine was offline, and prints nothing when none did. `~/.claude-bb/bb-import.json` remembers what each thread became.

magpie reads them once Claude Code's and Codex's sessions are allowed: `magpie sessions read on claude` and `magpie sessions read on codex`.

### bb's memories in magpie's Memory

magpie never reads an agent's own memory files. Claude Code and Codex add to Memory through magpie's `memory_save` tool, and `import.mjs` saves every bb memory (`bb memory`) the same way after the threads, with `magpie tool memory_save`. Each one is an agent's memory, given to every agent at once, which Memory's nightly tidy may merge or set aside like any other.

- The text is bb's summary and the command that prints the whole record, such as `BB_PROJECT_ID=proj_personal bb memory get mem_…`. The details stay in bb, so the digest magpie gives agents has room for more memories. bb's reason for keeping it becomes the memory's *why*, its tags gain `bb`, and a bb `decision` becomes an `episode`.
- A project's memory belongs to that project's folder on this computer, wherever bb has one. bb's global memories, Personal's, and those of a project with no folder here hold everywhere.
- A memory bb changed goes into the same magpie memory, and one bb deleted is set aside in magpie. Nothing is set aside on a run where a list couldn't be read whole. `~/.claude-bb/bb-memory.json` remembers which magpie memory each became.
- What tidy did stands. A memory it merged into another is left as it is, and bb's next change to it is saved as a new memory. A memory tidy or you set aside stays aside when bb changes or deletes it. The importer reads a memory's status from its file in `~/.config/magpie/memory`, since `memory_save` doesn't report it.
- magpie must be running. A run where it isn't reports the memories as failed and saves them the next time.

`bb` must work where it runs, as it does in a bb thread or a bb terminal on this computer. To run it every day from a bb automation, use a script automation that starts it in a terminal on this computer:

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

选项：`port`（默认 3498）是页面本地服务的端口；`bbPath` 是 `bb` 的完整路径，留空时先找本机的 bb 主机守护进程（见下），再依次查找 `$BB_CLI`、`PATH`、`~/.local/bin`、`/opt/homebrew/bin` 和 `/usr/local/bin`。

`node import.mjs` 把所有 bb 线程（包括已归档和隐藏的）放到本机 magpie 能读到的地方，magpie 的会话页、用量、`magpie sessions search` 和记忆的「从对话中学习」都能读到；需先运行 `magpie sessions read on claude` 和 `magpie sessions read on codex`。在其他机器上运行的线程，若 bb 能读到那台机器上智能体自己的会话文件（`bb file read --host`，按 bb 给的 SHA-256 校验），就原样复制过来：Claude Code 的（连同子代理的文件）放进 `~/.claude-bb/projects`，Codex 的放进 `~/.codex-bb/sessions`，magpie 能看到其中的模型、token 数和费用，只把其中的文件夹改成本机的。其余线程写成 Claude Code 会话，放在 `~/.claude-bb/projects`：只保留你写的和智能体回答的文字，每条回答注明 bb 运行该轮所用的模型，插件或父线程智能体写的提示不算作你的话；bb 不记每轮的 token 数，所以费用显示为 0。超过 25 MB（`bb file read` 的上限）的会话文件、压缩的 Codex 记录（`.jsonl.zst`）、Kimi 和 Muse 线程、已移除机器上的线程都这样写；离线机器上的线程先这样写，下次运行再试。会话放在该线程所属项目在本机的文件夹下（Personal 的线程和本机没有文件夹的项目的线程放在主文件夹下）；本机已有 Claude Code 或 Codex 会话的线程不重复写入；再次运行只取有变化的线程和上次离线的机器上的线程。之后它用 `magpie tool memory_save` 把每条 bb 记忆（`bb memory`）存进 magpie 的记忆，和 Claude Code、Codex 存记忆的方式一样：内容是 bb 的摘要和查看完整记录的命令，项目记忆归到该项目在本机的文件夹（没有文件夹的和 Personal 的对所有项目生效）；bb 改了的记忆更新同一条，bb 删掉的在 magpie 里搁置；整理合并过的记忆保持原样，bb 之后的修改另存为新记忆，被整理或你搁置的记忆一直搁置。运行时 magpie 需要开着。

本地服务只监听 `127.0.0.1`，拒绝 `Host` 不是本机端口的请求，每次 API 调用都要带上页面里的随机令牌，`bb thread open` 只接受形如 `thr_…` 的线程 ID。找不到 `bb` 或命令失败时，页面显示 bb 自己的错误信息和重试按钮。bb 服务器在另一台机器上时，插件像 bb 自己的线程那样经本机的 bb 主机守护进程连接：从 `~/.bb-machines/<服务器>/host-daemon-port` 读出守护进程的端口，用 `lsof` 找到它所用的 node 和它监听的其他本机端口（其中之一是它加上本机凭据的代理），用守护进程旁边的 bb 逐个试，记住能用的那个，命令失败后重新查找。插件不读凭据。bb 没有公开这些细节，升级后可能失效，那时页面显示 bb 的错误。设置 `bbPath` 则不查找。
