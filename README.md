# Projects

A project board for DeepSeek Harness. A project holds one goal: standing
instructions, a workspace, a shared memory file, and a board of tasks. One
coordinator session plans and dispatches; every task runs as a worker subagent
with its own context, and its final message lands on the task for review.

## Where it lives

- Left sidebar: a **Projects** entry (board glyph) opens the project page.
- The page is three columns: **projects** | **main conversation** | **executors**.
  - Column 1 lists projects and creates new ones; it collapses to a narrow icon
    rail, and the two column edges are draggable (both widths and the collapsed
    state are remembered locally).
  - Column 2 is the project's coordinator conversation: the real DSH chat with
    its composer. **Start coordinator** creates the Session and sends the
    coordinator prompt; **Settings** switches this column to instructions,
    shared memory, dispatch policy, worker model/effort and workspace.
  - Column 3 is the Threads panel: five collapsible groups (running, ready for
    review, waiting on you = blocked + failed, idle = queued, resolved — folded
    by default). A card is a status icon, the title (single line, ellipsised), a
    relative time, a one-line summary and optional chips (model, task id) — no
    body text, no controls. Click a card to open its detail view in the same
    column: the executor's own conversation, with a back button. The task brief
    is not repeated there — it is already the first message of that
    conversation, and the worker's final message is the output. **Resolve** sits
    at the top right of the detail view; **delete** lives only in the card's
    right-click menu.
- Each `projects_dispatch` call in the coordinator conversation renders as a
  clickable task card: title, read-only status pill, relative time and a
  resolved chip. Clicking it opens that task's detail view (switching projects
  first when needed). The card is display-only and never writes task state.
- The agent gets eight tools: `projects_list`, `projects_create`,
  `projects_update`, `projects_get`, `projects_add_task`,
  `projects_update_task`, `projects_memory` and `projects_dispatch`.
  `projects_get` returns the tasks plus an **index** of the shared memory
  (section titles and sizes), not the memory text; read one section with
  `projects_memory`.

## The loop

1. Create a project on the page (or with `projects_create`). The workspace is
   optional: **Choose folder** opens the Host's own directory chooser (the same
   dialog the workspace picker uses), and a project with no folder inherits the
   coordinator session's directory. Then click **Open coordinator**: the page
   creates the project's coordinator Session, sends the coordinator prompt into
   it, and shows the conversation beside the board.
2. The coordinator splits the goal with `projects_add_task` and dispatches with
   `projects_dispatch`. Dispatch returns immediately; the coordinator stays
   responsive.
3. Each worker receives the project instructions, an **index** of the shared
   memory (section titles and sizes, not the text — it reads the one section it
   needs with `projects_memory`) and the task brief, runs in the project
   workspace, and appends durable findings to the shared memory through
   `projects_memory`.
4. When a worker settles, its final message becomes the task output and the
   task moves to **Ready for review**. The human accepts it by toggling
   **Resolve** in the task detail view: status is system-owned and read-only, so
   acceptance is the `resolved` flag, not a status edit. To send work back or
   add a follow-up, say so in the main conversation and let the coordinator
   derive a new task. Deleting a task is in the row's right-click menu.

## Dispatch policy

- **Manual** (default): a task needs human approval on the page before the
  coordinator may dispatch it. This is the approval point.
- **Auto**: the coordinator dispatches without waiting.
- **Parallel workers** caps how many tasks run at once (1-8). This is
  deliberately aligned with the Host's own subagent pool
  (`maxActiveSubagents`, default 8), so the plugin never admits a worker the
  Host would reject: the ninth task is refused in the plugin with
  `Concurrency limit reached (8/8 workers running)`.

## Data and limits

- Data lives on this machine under `$DSH_HOME/projects/<projectId>/`:
  - `project.json` — the project and its tasks.
  - `memory.md` — the live shared memory. Workers and the page get an index of
    it; the text is read one section at a time.
  - `memory-archive.md` — sections moved out of `memory.md` by auto-compaction.
    Append-only, and never injected into a prompt. Archived sections are still
    readable with `projects_memory` (`action: "read"` falls back to the archive,
    and `action: "index"` lists the archived titles).
  - `memory.bak.md` — a full copy of the memory taken before each compaction.
    Never deleted automatically.

  Deleting the plugin does not delete any of it.
- **Auto-compaction**: after an append or a page save, once the memory exceeds
  the project's `memoryBudget` (default 64000 characters, clamped to
  4000–200000) and `autoCompact` is not false, the Host moves whole oldest
  sections into the archive until it is down to 60% of the budget. Sections are
  never split and the newest one always stays. It backs up first, verifies the
  write, and rolls back on any mismatch, so nothing is silently dropped. Turn it
  off per project with `autoCompact: false` to keep the memory append-only.
- Workers are in-process subagents: they stop when the plugin is disabled or
  the process exits. There is no cloud execution in this version, and two
  planned features are still missing: **per-task git worktree isolation** (each
  task gets its own branch/worktree) and **scheduled or event-triggered runs**.
- Project instructions are capped at 16000 characters; each task output keeps
  the last 4000 characters of the worker's final message.
- The worker route is a project setting (`model`, `reasoningEffort`,
  `agentPreset`) with the same fields overridable per task; empty means inherit,
  falling back to the Host default.
