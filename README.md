# Projects

A project board for DeepSeek Harness. A project holds one goal: standing
instructions, a workspace, a shared memory file, and a board of tasks. One
coordinator session plans and dispatches; every task runs as a worker subagent
with its own context, and its final message lands on the task for review.

## Install

The package is a DSH bundle. `package.json` declares `dsh.bundle.patch`
(`cordis.patch.yml` inserts the Host plugin row) and `dsh.client` (the Client
module is discovered from the same package), so one installation provides both
halves. Install it into a profile in one of four ways.

### From npm (recommended)

The package is published to npm as `@fatwang2/dsh-projects`. Ask the agent to
run `plugin_manager` with `action: "install_bundle"` and `target` set to the
package spec:

- `@fatwang2/dsh-projects` — the `latest` dist-tag, so the install takes the
  newest release.
- `@fatwang2/dsh-projects@0.2.0` — an exact version, when you want to lock it.

A registry install is the easiest to upgrade: the Host records the version it
installed, and the Plugins page compares it with the registry and offers
**Update** when a newer release exists. The profile then lists
`@fatwang2/dsh-projects` in `dsh.profile.bundles` and records the exact version
in its `dependencies`:

```json
{
  "dsh": { "profile": { "bundles": ["@fatwang2/dsh-projects"] } },
  "dependencies": {
    "@fatwang2/dsh-projects": "0.2.0"
  }
}
```

### From GitHub

Ask the agent to run `plugin_manager` with `action: "install_bundle"` and
`target` set to the repository spec:

- `github:fatwang2/dsh-projects` — the default branch's current commit.
- `github:fatwang2/dsh-projects#v0.2.0` — a release tag. Pin a tag to lock the
  version.

There is no clone and no build step: the Host installs the package and selects
the bundle. The profile then lists `@fatwang2/dsh-projects` in
`dsh.profile.bundles` and records the spec in its `dependencies`:

```json
{
  "dsh": { "profile": { "bundles": ["@fatwang2/dsh-projects"] } },
  "dependencies": {
    "@fatwang2/dsh-projects": "github:fatwang2/dsh-projects#v0.2.0"
  }
}
```

### From a local directory

Clone the repository, then pass the checkout's absolute path as `target`
instead of a spec:

```sh
git clone https://github.com/fatwang2/dsh-projects.git
```

A directory install is a `link:` dependency, so `files` does not filter what
runs: edit the sources in place and the next reload picks the changes up.

### From the Plugins page

Open **Plugins**, choose **Add plugin** → **Install a third-party plugin**, and
paste the same spec — `@fatwang2/dsh-projects@0.2.0` (or the bare name for
`latest`) or `github:fatwang2/dsh-projects#v0.2.0` — or the absolute path of a
local checkout.

A newly installed Client module needs one page refresh before the **Projects**
entry appears. Disabling or removing the bundle leaves every project on disk.

## Update

A git install is pinned to the ref it was given: `#v0.2.0` stays that release
until you ask for another one, and a spec with no ref follows the default
branch's current commit. An npm install is pinned too:
`@fatwang2/dsh-projects@0.2.0` stays that version, and a bare name installs
whatever `latest` was at install time. To upgrade:

1. **npm install**: open **Plugins** and the bundle's page. Its **Versions**
   section lists the newer releases the registry has, and **Update** replaces
   the installed version while keeping the bundle selected — the version
   discovery a registry install adds. Without the page, remove the bundle first
   — `plugin_manager` → `remove_bundle` with
   `target: "@fatwang2/dsh-projects"` — then install the new version:

   ```
   target: "@fatwang2/dsh-projects@0.2.0"
   ```

   The removal is not optional: with hot reload, `install_bundle` refuses a
   package that is already installed (`already-installed`).
2. **git install**: install the newer ref — the same `plugin_manager` →
   `install_bundle` call with the new tag in place of the old one:

   ```
   target: "github:fatwang2/dsh-projects#v0.2.0"
   ```

   `v0.2.0` stands for the release you want; passing `#main` follows the branch
   instead of a tag. The Plugins page's **Update** action does the same when it
   is offered for a git install. If the profile reports that the bundle is
   already installed, remove it first, as in the npm step, then install the new
   ref.

`plugin_manager` → `list_plugins` shows what is installed. After an upgrade,
reload the plugin when the Host half changed (the Plugins page asks for a
restart when the profile has no hot reload) and refresh the page when the
Client half changed. Projects, tasks and shared memory are not touched by an
install, an upgrade or a removal: they live in `$DSH_HOME/projects/<projectId>/`.

## Where it lives

- Left sidebar: a **Projects** entry (a stacked-card glyph drawn on a 24 grid
  with `currentColor` strokes) opens the project page. The plugin-market icon
  (`icon.svg`) follows the Host's plugin-icon convention instead: a 36 grid,
  filled colour, and padded content.
- The page is three columns: **projects** | **main conversation** | **executors**.
  - Column 1 lists projects. The `+` glyph in its header opens a create dialog
    (name, instructions, optional workspace, autonomy, concurrency); the
    panel-left glyph collapses the column to a narrow icon rail, and the two
    column edges are draggable (both widths and the collapsed state are
    remembered locally).
  - Column 2 is the project's coordinator conversation: the real DSH chat with
    its composer. **Start coordinator** creates the Session and sends the
    coordinator prompt. The gear glyph in this column's header opens a
    **settings dialog** with a left nav of two groups: **General** (project
    name, instructions, workspace, **Threads** — concurrency, model and
    reasoning effort — and, as its last section, **archive project**) and
    **Shared memory**. Archiving takes two clicks (arm, then confirm; the mask
    does not dismiss it while armed).
  - Column 3 is the Threads panel: five collapsible groups (running, ready for
    review, waiting on you = blocked + failed, idle = queued, resolved — folded
    by default). The panel head carries two glyphs: **search** (unfolds a field
    that filters on title and summary, and clears when folded again) and
    **filter** (show or hide each of the five groups, plus fold-all/expand-all).
    There is no refresh control; a 4s poll keeps the cards current. A card is a
    status icon, the title (single line, ellipsised), a relative time, a
    one-line summary and optional chips (model, task id) — no body text, no
    controls. Click a card to open its detail view in the same column: the
    executor's own conversation, with a back button. The task brief is not
    repeated there — it is already the first message of that conversation, and
    the worker's final message is the output. **Resolve** sits at the top right
    of the detail view; **delete** lives only in the card's right-click menu
    (two-step confirm).
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

1. Click the `+` glyph in the first column's header (or call
   `projects_create`). The dialog takes a name, the instructions, an optional
   workspace, autonomy and concurrency. **Choose folder** opens the Host's own
   directory chooser (the same dialog the workspace picker uses), and a project
   with no folder inherits the coordinator session's directory. Then click
   **Start coordinator**: the page creates the project's coordinator Session,
   sends the coordinator prompt into it, and shows the conversation beside the
   board.
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
   **Resolve** in the task detail view. `status` is a single enum and `resolved`
   is one of its values: Resolve writes `status: "resolved"`, and toggling it
   again sends the task back to `review`. There is no separate `resolved`
   boolean. To send work back or add a follow-up, say so in the main
   conversation and let the coordinator derive a new task. Deleting a task is in
   the row's right-click menu (two-step confirm).

## Autonomy and Threads

- **Manual** (default): a task needs human approval on the page before the
  coordinator may dispatch it. This is the approval point.
- **Auto**: the coordinator dispatches without waiting.
- **Concurrency** — the first field of the settings dialog's **Threads**
  section — caps how many tasks run at once (1-8). It is deliberately aligned
  with the Host's own subagent pool (`maxActiveSubagents`, default 8), so the
  plugin never admits a worker the Host would reject: the ninth task is refused
  in the plugin with `Concurrency limit reached (8/8 workers running)`.

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
- **Sessions are archived, never deleted.** DeepSeek Harness has no way to
  delete a session — its own UI says sessions can be archived but are never
  deleted. Deleting a task can archive its worker session with
  `DELETE /projects-api/projects/:id/tasks/:taskId?session=archive`; the route
  only ever touches that task's own `childSessionId`, refuses the coordinator
  session and a worker that is still running, and
  `?session=1|true|delete|remove|yes` is rejected (400) rather than silently
  downgraded to an archive. Archiving frees **no disk space**: it hides the
  session from the default sidebar and refuses it further model steps, while
  `$DSH_HOME/sessions/` keeps every byte. The page's delete menu offers both:
  right-click a task row, choose **Delete**, and the second stage offers
  **Delete task only** and **Delete and archive session** (the latter only when
  the task has an executor session). A successful archive reports "Task
  deleted, session archived."; a 409 — the worker is still running — keeps the
  task on the board and asks you to wait for it to finish.
- **Auto-compaction**: after an append or a page save, once the memory exceeds
  the project's `memoryBudget` (default 64000 characters, clamped to
  4000–200000) and `autoCompact` is not false, the Host moves whole oldest
  sections into the archive until it is down to 60% of the budget. Sections are
  never split and the newest one always stays. It backs up first, verifies the
  write, and rolls back on any mismatch, so nothing is silently dropped. Turn it
  off per project with `autoCompact: false` to keep the memory append-only.
- **Per-task git worktree isolation** (opt-in, off by default): the project
  setting `worktreeIsolation` — a boolean, settable with `projects_update` —
  gives every task its own checkout at `<workspace>/.worktrees/<taskId>` on
  branch `task/<taskId>`, and the worker's `cwd` points there, so two workers of
  the same project cannot overwrite each other's files. The workspace must be a
  git repository that **already ignores `.worktrees/`**: dispatch refuses with an
  actionable error instead of leaving an untracked directory in `git status`, and
  a start that fails after creation removes the checkout it just made. The
  worktree is **kept after the worker settles** — the human reviews it and merges
  it, nothing is merged automatically — and is removed together with its branch
  when the task is deleted or the project is archived. When the workspace is not
  a git repository (or is missing), isolation degrades instead of failing: the
  worker runs in the shared workspace and the task records why in
  `worktreeDegraded` / `worktreeNote`.
- Workers are in-process subagents: they stop when the plugin is disabled or
  the process exits. There is no cloud execution in this version, and three
  planned features are still missing: **scheduled or event-triggered runs**, a
  **global pause / reporting policy**, and an **output library** (task outputs
  and workspace files collected on the page).
- Project instructions are capped at 16000 characters; each task output keeps
  the last 4000 characters of the worker's final message.
- The worker route is a project setting (`model`, `reasoningEffort`,
  `agentPreset`) with the same fields overridable per task; empty means inherit,
  falling back to the Host default.

## Design

[docs/DESIGN.md](docs/DESIGN.md) is the design note: the capability comparison
against Claude / Cursor Projects, the prototype architecture, the Host and
Client extension points it builds on, the gaps that need infrastructure rather
than a plugin, and the verification status.
