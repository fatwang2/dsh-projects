# Projects

A project board for DeepSeek Harness. A project holds one goal: standing
instructions, a workspace, a shared memory file, and a board of tasks. One
coordinator session plans and dispatches; every task runs as a worker subagent
with its own context, and its final message lands on the task for review.

## Where it lives

- Left sidebar: a **Projects** entry (board glyph) opens the project page.
- The page is three columns: **projects** | **main conversation** | **executors**.
  - Column 1 lists projects and creates new ones.
  - Column 2 is the project's coordinator conversation: the real DSH chat with
    its composer. **Start coordinator** creates the Session and sends the
    coordinator prompt; **Settings** switches this column to instructions,
    shared memory, dispatch policy and workspace.
  - Column 3 is the executors panel, grouped by status (ready for review,
    running, queued, failed, blocked). A row is just a status pill, the task
    title and the worker name — no body text, no controls. Click a row to open
    its detail view in the same column (brief, full output, stop reason, the
    executor's own conversation, and a back button). **Resolve** sits at the top
    right of the detail view; **delete** lives only in the row's right-click
    menu.
- The agent gets `projects_list`, `projects_create`, `projects_get`,
  `projects_add_task`, `projects_update_task`, `projects_memory` and
  `projects_dispatch`.

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
3. Each worker receives the project instructions, the shared memory and the
   task brief, runs in the project workspace, and appends durable findings to
   the shared memory through `projects_memory`.
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
- **Parallel workers** caps how many tasks run at once (1-10). The Host's own
  subagent pool (`maxActiveSubagents`) defaults to 8, so in practice at most 8
  workers run at the same time until that is raised in the profile patch.

## Data and limits

- Data lives on this machine under `$DSH_HOME/projects/<projectId>/`
  (`project.json` and `memory.md`). Deleting the plugin does not delete it.
- Workers are in-process subagents: they stop when the plugin is disabled or
  the process exits. There is no cloud execution in this version, and two
  planned features are still missing: **per-task git worktree isolation** (each
  task gets its own branch/worktree) and **scheduled or event-triggered runs**.
- Project instructions are capped at 16000 characters; each task output keeps
  the last 4000 characters of the worker's final message.
