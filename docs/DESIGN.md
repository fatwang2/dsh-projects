# Reproducing Claude / Cursor Projects in DSH with a plugin

Research findings, feasibility assessment and a working prototype (v1). Every
conclusion below is based on the actual source and documentation of the
DeepSeek Harness installed on this machine (desktop profile,
`@deepseek-ai/dsh` 0.2.2-rc.3) and on the official Claude / Cursor
documentation as of 2026-11.

---

## 0. Conclusion

**It can be built, and no fork is needed.** Of the six core capabilities, 1, 2,
3, 4 and 6 can be reproduced completely by a single plugin; item 5 — "always-on
in the cloud + external event triggers" — can only be reproduced within one
machine, because a multi-tenant cloud sandbox is a Host capability, not
something a plugin can add.

The prototype is written, installed into the desktop profile, and verified end
to end on the Host side:

- Plugin directory: [projects-plugin](..)
- Host: project store + same-origin `/projects-api/*` routes + 8 `projects_*`
  tools + subagent dispatch and write-back
- Client: a **Projects** entry in the left sidebar + a full-page board in
  `main` (project list / coordinator conversation / settings dialog with the
  archive action / task board / approval)
- Zero Host changes: only public extension points were used (slot, tool,
  webServer, subagents, locale)

---

## 1. Capability comparison

| # | Projects capability | How Claude / Cursor does it | The DSH mechanism it maps to | Plugin-feasible | Prototype status |
|---|---|---|---|---|---|
| 1 | Coordinator: the single conversation entry point, which only splits, dispatches and accepts | coordinator agent / coordinator conversation | a real Session embedded in the project page (`main` declares a session sub-slot + a `conversation.content` factory) + the `projects_*` tools | ✅ | ✅ Done (the coordinator conversation sits in the right column of the project page; no navigation away) |
| 2 | Parallel workers: own context, own environment, delivers PRs/docs | cloud thread (own branch + repo copy) / isolated VM + branch | `ctx.subagents.startActivation({provider:'spawn', parent, delivery:'parent'})`: each worker is its own Session with its own context; `cwd` sets the working directory | ✅ (branch isolation needs a worktree on top) | ✅ Done (parallel + concurrency cap + result write-back); ⚠️ branch isolation not done |
| 3 | Long-lived shared memory: every worker reads and writes it, and humans can view and edit it | `MEMORY.md` index / Agent Store synced files | a per-project `memory.md`: dispatch injects a **section index** (titles + character counts, not the full text); workers read and append one section at a time with `projects_memory`; the page edits it directly; over-budget content is archived automatically | ✅ | ✅ Done |
| 4 | Task status and visibility: overview panel + outputs | Overview (Threads/Library) / List+Board | a three-column page: column 3 is the Threads panel, which groups task cards by status; click a card to open its detail page (the worker session, whose output is its final message); a 4s poll | ✅ | ✅ Done (grouping, output, worker session, search, group show/hide and folding) |
| 5 | Continuous running and autonomous progress: cloud, watching PRs/CI, scheduled or event triggers | an always-on Cloud VM / Slack, schedule, PR subscriptions | an always-on local process; `ctx.schedule` (cron) plus goal/ralph loops can do "scheduled + autonomous rounds"; no cloud, no built-in Slack/PR subscription | ⚠️ Partial | ❌ Not in v1 (see §5, next steps) |
| 6 | Human gatekeeping: autonomy, concurrency, approval points, pause/archive | auto mode + permission prompts / Input Needed + an approval switch | per-project `autonomy` (manual/auto) + `concurrency` (1-8) + per-task `approved` + `archived`; approval happens on the page | ✅ | ✅ Done (in manual mode, dispatching an unapproved task is refused by the tool) |
| 7 | Project configuration: instructions, codebase, environment, tools, model | Project settings | instructions (≤16000 characters), workspace (the native directory picker, may be empty), concurrency, autonomy, memory budget/auto-compaction; models and tools can be extended with an agent preset | ⚠️ Partial | ✅ instructions / directory picker / concurrency / autonomy + a per-project model and reasoning effort (project default + task override + `agentPreset`) + `autoCompact`/`memoryBudget`; ❌ per-project tool restrictions |
| 8 | Library / output store | Library (files, artifacts) | project workspace files + task output; no separate library UI | ⚠️ Partial | ❌ Not in v1 |
| 9 | Usage control | plan limits / spend limit | the Host already has a token meter and session statistics; the plugin does not rebuild them | ✅ (reuses the Host) | — |
| 10 | Cloud and local execution | cloud by default, a local agent can be pulled in | local only; `cwd` can point at any directory | ❌ cloud | — |
| 11 | Team collaboration / multiple people | multiplayer: a shared board + Context | no built-in multiplayer; the LiveShare plugin can share a single session, which is not a shared project | ❌ | — |

---

## 2. Prototype architecture

```
human ── project page (main slot: projects, three columns)
   ├── column 1: project list (the `+` glyph in the header opens the create dialog;
   │              the fold glyph collapses the column to 44px)
   ├── column 2: main conversation (the coordinator, a real embedded Session);
   │              the gear glyph in the header opens the settings dialog
   │              (two groups: General, with archive last, and Shared memory)
   └── column 3: Threads panel (grouped by status; search/filter glyphs in the
                  header; click a card to open the detail page = the worker session)
                  │
                  │  "Start coordinator" = create/reuse the Session + send the coordinator prompt
                  ▼
        coordinator agent (an ordinary Session, right there in column 2)
                  │ projects_add_task / projects_dispatch
                  ▼
        Host plugin (project store + /projects-api + projects_* tools)
                  │ ctx.subagents.startActivation
                  ▼
        worker subagent (own Session / own context)
          · prompt = project instructions + memory section index + task brief
          · cwd = project workspace
          · appends its conclusions with projects_memory when it finishes
                  │ subagent/end
                  ▼
        Host plugin writes the last assistant message back onto the task → status review
                  │
        human accepts (resolve / retry / add a follow-up task)
```

### Data

```
$DSH_HOME/projects/<projectId>/project.json       # project + tasks
$DSH_HOME/projects/<projectId>/memory.md          # shared memory (live file, injected as an index)
$DSH_HOME/projects/<projectId>/memory-archive.md  # historical sections moved out by auto-compaction (append-only, never injected into a prompt)
$DSH_HOME/projects/<projectId>/memory.bak.md      # full backup taken before each compaction (never deleted automatically)
```

**Memory archiving**: after an `append` / `write` (both the tool surface and the
page's `POST .../memory` count), once the memory exceeds `memoryBudget`
characters and `autoCompact !== false`, the Host moves the oldest `## ` sections
**whole** into `memory-archive.md` (with a one-line run header
`## Compaction <iso> — before → after characters, budget N`) until it is down to
60% of the budget; the newest section always stays, and a section is never
split. The order is "back up → append to the archive → write `memory.md` → read
back and verify", and any mismatch writes the original text back, so nothing is
lost silently. Archived sections stay readable:
`projects_memory {action:'read', section:'<old title>'}` falls back to
`memory-archive.md`, and `action:'index'` lists the archived titles after the
live index; but **the worker prompt's index deliberately excludes the archive**.
`project.lastCompaction = {at, before, after, archived}` records the most recent
compaction.

Project: `id / name / goal(instructions) / workspace / autonomy / concurrency /
model / reasoningEffort / agentPreset / autoCompact / memoryBudget /
lastCompaction / archived / tasks[]`
(`workspace` is optional: the page opens the Host's own native directory picker
through `ctx.uiWorkspace.pickDirectory()`, and a project without a directory
inherits the coordinator session's directory)
Task: `id / title / brief / status(queued|running|review|failed|blocked|resolved) /
approved / model / reasoningEffort / agentPreset / childSessionId / childName /
output / stopReason / timestamps`
(`model` / `reasoningEffort` / `agentPreset` are defaults at project level and
are overridden by the same-named task field; an empty value means inherit, and
the final fallback is the Host default)

### Host ([host/index.js](../host/index.js))

- `export const inject = ['webServer', 'tools']`; `subagents` is read optionally
  with `ctx.get()`, so the board still works when no subagent service is
  present.
- `ctx.webServer.register({ kind: 'prefix', path: '/projects-api', handler })`:
  same-origin REST, the same approach as the installed `@mailly/dsh`.
- `ctx.tools.register(...)` registers 8 tools: `projects_list / projects_create /
  projects_update / projects_get / projects_add_task / projects_update_task /
  projects_memory / projects_dispatch`. `projects_get` returns the task list and
  the **memory index** (titles + character counts), never the memory body.
- `ctx.on('subagent/end', ...)`: finds the task by `childSessionId` and writes
  `output` and the status back onto it.
- Dispatch uses the plugin's own `AbortController` (not `exec.signal`), and
  unloading the plugin aborts them all.

### Client ([client/index.js](../client/index.js))

- `window.__ModuleLoader__.load({ id: '@fatwang2/dsh-projects', factory })`;
  `factory` returns `{ inject: ['slots','locale','uiWorkspace','sessions'], apply }`.
- `ctx.slots.inject('sidebar.panellist', ...)`: the **Projects** entry in the
  left sidebar plus a hand-drawn icon (a 24 grid, stroked, `currentColor`, a
  stacked-card shape).
- `ctx.slots.inject('main', ...)`: the full-page board with `key: 'projects'`
  (the same mechanism as the Plugins and Schedules pages).
- `ctx.slots.inject('projects.conversation', ...)`: the coordinator conversation
  embedded in the project page (a `conversation.content` factory).
- `ctx.slots.inject('tool.call.toolview', ...)`: `key: 'projects_dispatch'`,
  which renders every dispatch in the conversation as a clickable task card
  (clicking it opens that task's detail view).
- Styling uses only `--dsw-*` theme tokens (`--dsw-alias-*` mostly, plus
  `--dsw-radius-*` / `--dsw-focus-ring-*` / `--dsw-elevation-*`); bilingual, and
  it follows the Host theme.

---

## 3. The reusable conclusions that matter most for DSH

1. **A full page needs no Host change**: `main` is a keyed slot, and the sidebar
   entry's id is the dispatch key. `client-ui-plugin-manager` (the Plugins page)
   and `client-ui-schedule` (the Schedules page) both work this way, so a
   third-party plugin can copy the pattern.
2. **A plugin can ship its own backend**: `ctx.webServer.register({kind:'prefix'})`
   plus a same-origin `fetch` is the least-effort path for a user plugin to get
   data today (proven by `@mailly/dsh`). There is no need to touch the Remote API
   gateway.
3. **Coordinator/worker = an ordinary Session + a subagent**:
   `ctx.subagents.startActivation` with `delivery:'parent'` notifies the parent
   agent when a worker finishes — exactly "the worker hands the result back";
   `delivery:'caller'` instead suits a plugin that collects results itself.
4. **Shared memory as a file + a section index in the prompt** is the closest
   thing to Claude's `MEMORY.md` model, and humans can edit it directly; the
   index decouples prompt size from memory size, and over-budget content is
   archived whole sections at a time instead of being silently truncated.
5. **An approval point can be data**: `autonomy=manual` + `task.approved`,
   checked by the tool before dispatch and granted by the page. That is closer to
   the Projects product semantics than intercepting tool calls for permissions.

---

## 4. The real gaps against Claude / Cursor

| Gap | Why a plugin cannot close it | What works today instead |
|---|---|---|
| An isolated cloud VM that keeps running after you close the laptop | needs a managed execution environment; DSH is a local process | an always-on local process + `ctx.schedule`; it stops when the laptop sleeps |
| A git branch per task + an automatic PR / CI watch / auto-fix | needs a GitHub integration and PR lifecycle management | `dsh-experimental-tool-worktree` (one worktree per task) + the `gh` CLI; can be built into the plugin later |
| Shared memory across machines (Agent Store) | needs a sync service | put the project directory on iCloud/Dropbox or in a git repository |
| Multiplayer, a shared board | needs accounts, permissions and realtime sync | the LiveShare plugin can only share a single session |
| Usage/billing, a daily thread cap | Host/platform layer | the Host token meter + session statistics |
| Slack / PR event triggers | needs a webhook intake | a scheduled task + an external script calling the `projects_*` tools (needs a wrapper first) |

Conclusion: **80% of the product shape can be a plugin; the remaining 20% is the
two pieces of infrastructure — "cloud" and "multiplayer" — and neither can be
added by forking. They need a server.**

---

## 5. Next steps (ordered by value for effort)

1. **Per-task git worktree isolation**: create a worktree for the task before
   dispatch, point `cwd` at it, record the branch on the task; merge or discard
   it after acceptance. Reuse `dsh-experimental-tool-worktree` directly.
   **Status: not done.**
2. **Scheduled / event-triggered runs**: use `ctx.schedule` to create a task that
   "checks queued tasks every N minutes and dispatches them", or hook the `goal`
   / ralph loop for autonomous rounds.
   **Status: not done.**
3. **Per-project model / tool restrictions**: store an agent preset id in the
   project config and pass `agentPreset` on dispatch.
   **Status: done (the model half).** Project-level `model` + `reasoningEffort`
   with same-named task overrides (`task.model || project.model`, the same for
   effort), translated into `startActivation`'s `agentOptions` at dispatch;
   `agentPreset` is passed through as-is; `GET /projects-api/models` exposes the
   available models (with each model's effort list) and presets (when the Host
   has no `llm` service it returns `enumerable:false` and the UI degrades to a
   free-text field). **Tool restrictions are still not done.**
4. **Global pause / reporting frequency**: a project-level `paused` field
   checked before dispatch; reporting frequency as a notification policy.
   **Status: not done.**
5. **Output library**: collect task outputs and workspace files into a
   "material" area of the project page, with attachments.
   **Status: not done.**
6. **Teams**: wait for LiveShare / multiplayer infrastructure, or start with
   "put the project directory on a shared drive".

---

## 6. Verification status

| Item | Result |
|---|---|
| Installation | `plugin_manager install_bundle` → `application: applied`, no warning |
| Host routes | `GET /projects-api/projects` → `200 {"projects":[]}` |
| Host tools / storage / dispatch / write-back | the full automated suite passes (`npm test`: both test suites, 100+ tests): tool registration (8), project CRUD and settings updates, memory append/overwrite/index/read-by-section, over-budget auto-compaction and archiving, the manual approval gate, dispatch arguments and prompt assembly, `subagent/end` write-back, HTTP routes, page write-surface isolation, legacy data migration, the concurrency gate, model/effort routing, Threads grouping and cards, in-conversation dispatch cards, column widths / fold persistence, control and Host primitive alignment, dialogs (focus/Esc/scroll lock), and the optional session archive when deleting a task |
| Status model | `done` is gone. `status` is a single enum — `queued\|running\|review\|failed\|blocked\|resolved` — and `resolved` is the human verdict; there is deliberately no second `resolved` boolean. Legacy data migrates on read: `status:'done'` or `resolved:true` → `status:'resolved'`; an unknown status → `queued` |
| HTTP write surface | the page has only three narrow doors: `PATCH /projects-api/projects/:id` writes **project settings** (name/goal/workspace/autonomy/concurrency/model/reasoningEffort/agentPreset/autoCompact/memoryBudget/archived) and never touches task status; `PATCH .../tasks/:taskId` accepts only `status`, and only `resolved` (accept) or `review` (take the acceptance back); `POST .../tasks/:taskId/approve` writes only `approved:true` (idempotent). `output`/`title`/`brief` are always 400 over HTTP; `POST /projects/:id/tasks` was removed (404), so tasks can only be derived by the coordinator with `projects_add_task` |
| HTTP route list | everything hangs under the `/projects-api` prefix, in 7 path groups: `GET\|POST /projects`, `GET\|PATCH /projects/:id` (PATCH = project settings), `GET\|POST /projects/:id/memory`, `PATCH\|DELETE /projects/:id/tasks/:taskId` (DELETE may carry `?session=archive`, see the next row), `POST /projects/:id/tasks/:taskId/approve`, `GET /models` (the model/preset catalog, read-only) and `POST /sessions/restore` (restore an archived coordinator session) |
| Session archiving | deleting a task can archive the worker session: `DELETE /projects-api/projects/:id/tasks/:taskId?session=archive` responds `{deleted:true, session:{id, archived:true}}`; without the parameter only the task is deleted (`session:null`). The session id always comes from the task's own `childSessionId`, so a request cannot name another session; the coordinator session is 409; a worker that is still running is 409 (it is never killed implicitly); when the session is already gone the task is still deleted and `archived:false` is returned. **DSH has no way to delete a session** (the product itself says "sessions can be archived but are never deleted"), so `?session=1/true/delete/remove/yes` is rejected with 400 instead of being silently downgraded to an archive. Archiving frees **no disk space**: it hides the session from the default sidebar and refuses it further model steps, while not one byte leaves `$DSH_HOME/sessions/`. After the page's right-click **Delete**, the second stage offers **two actions**: **Delete task only** (primary, danger colour) and **Delete and archive session** (secondary, **only when the task has a `childSessionId`**); a successful archive reports "Task deleted, session archived." (a Host `archived:false` reports only "Deleted."), a 409 for a worker that is still running keeps the task and asks you to wait for it to finish, and the coordinator-session 409 keeps the Host's own wording |
| Concurrency cap | 1-8 in the plugin layer (`MAX_CONCURRENCY = 8`; out-of-range values are clamped, not rejected). The 8 is **deliberately** aligned with the Host's `maxActiveSubagents` default: the plugin never admits a worker the Host would refuse. The ninth task is stopped in the plugin layer with `Concurrency limit reached (8/8 workers running)` instead of first being rejected by the Host pool and wrapped as `Could not start the worker: …`. No profile patch is needed |
| Worker sidebar | column 3 takes the Threads panel shape: five fixed, collapsible groups (`running` / `review` / `waiting`=`blocked`+`failed` / `idle`=`queued` / `resolved`, with Resolved folded by default); a card is a status icon + title (single line, ellipsised) + relative time + a one-line summary + optional chips (model / task id), with no body and no controls; clicking opens the detail view (a master-detail column replacement, with a back button), and **the detail view is the conversation view**: its body is only the worker's own session (the brief was already its first message at dispatch, so it is not echoed again) and the output is that conversation's final message; **Resolve** sits at the top right of the detail view, and delete lives only in the row's right-click menu (two-step confirm; closes on outside click / Esc / scroll, follows the mouse and is clamped into the viewport). The panel head carries two glyphs at the top right: **search** (unfolds a field only when clicked, filters on the title and the one-line summary, clears when folded) and **filter** (a menu that shows or hides each of the five groups plus fold-all/expand-all, with an extra "show all groups" row when something is hidden); there is **no refresh control** — the 4s poll keeps the cards current |
| Three-column layout | column 1's header holds `+` (the create dialog) and the fold glyph (`PanelLeftIcon`, the same icon as the DSH sidebar), which collapses the column to a 44px icon rail (`listCollapsed`); column 2's header holds only a gear glyph (the settings dialog), and the middle column has no tabs any more; a resizer sits between columns 1 and 2 and between columns 2 and 3 (draggable, and the arrow keys work too); column widths and the collapsed state are page-local preferences that survive a reload |
| In-conversation subtask cards | every `projects_dispatch` call from the coordinator renders a clickable task card in the conversation (the `tool.call.toolview` slot, key `projects_dispatch`): title, a read-only status pill, relative time, a resolved chip; clicking opens that task's detail view (a different project is switched first; with the page unmounted it silently does nothing). The card is display-only and issues no request of its own — its data comes from the board snapshot the page publishes |
| Data on disk | four files under `$DSH_HOME/projects/<id>/`: `project.json` (project + tasks), `memory.md` (live memory), `memory-archive.md` (sections moved out by compaction, append-only and never injected), `memory.bak.md` (a full backup before each compaction, never deleted automatically). Cleaned up after testing |
| Client module | the module id, `inject`, all four slot registrations (`sidebar.panellist` / `main` / `projects.conversation` / `tool.call.toolview`) and icon rendering are covered by unit tests |
| Theme tokens | every `--dsw-*` token the page uses exists in the theme package, and there are no literal colour values |
| Settings and archiving | settings is a **dialog** (triggered by the gear glyph in column 2's header, `role="dialog"` + `aria-modal`) with a left nav of **two groups**: **General** and **Shared memory**. **General** holds the project name, the instructions, the workspace, a **Threads** section (concurrency, model and reasoning effort) and, as its last section, **archive project** (the first click only arms it, the second runs it; while armed, clicking the mask does not dismiss it; unarchiving is not dangerous, so one click is enough). **Shared memory** holds the memory editor and its section list. Creating a project is a dialog too (triggered by the `+` glyph in column 1's header): name, instructions, workspace (+ choose folder), autonomy, concurrency, and cancel/create at the bottom |
| Icons | the sidebar entry is a hand-drawn **stacked-card** icon: a 24 grid, stroked (`stroke-width` 1.8, round caps and joins), `currentColor`, so it recolours with the theme; the plugin-market icon `icon.svg` follows the Host's plugin-icon convention instead: a **36 grid, filled colour, padded content** (like the Host's other plugins). The header triggers (`+` / gear / fold / search / filter) are the Host's 16-grid outline glyphs, 1.4 stroke, `currentColor` |
| Directory picking | creating a project and project settings both call `ctx.uiWorkspace.pickDirectory()` (the same native directory chooser as the Host workspace picker); it can be left empty and cleared; the actual dialog is unverified (needs a GUI session) |
| Embedded conversation | the project page declares the session sub-slot `projects.conversation` and renders a real session (composer included) with `renderFactorySlot('conversation.content', …)`; a `SessionProvider` binds the coordinator session and an error boundary catches failures; rendering is unverified (needs a GUI session) |
| UX review | an independent subagent reviewed the page against the Host's own Schedules page: 3 blockers + 9 should-fix + 4 nice-to-have, all fixed (error-colour contrast, cross-project input contamination, the missing `running` task status, the poll swallowing errors, feedback-banner placement, empty output for failed tasks, delete confirmation, the empty state's primary action, disabled archiving, focus ring, accessibility, losing edits on switch) |
| Browser rendering | **unverified**: the GUI needs a browser session token, and the verification rules say not to obtain one. A human must refresh the page and confirm the **Projects** entry appears in the left sidebar and that the page renders correctly |
| Detail-page artwork | not done (`meta.description` is enough; `icon.svg` is provided) |

### How to try

1. Refresh the DSH page (a newly installed Client module needs one refresh).
2. In the left sidebar click **Projects** → click the `+` glyph in column 1's
   header → fill in name/instructions in the dialog (workspace, autonomy and
   concurrency are optional) → create.
3. Click **Start coordinator**: the coordinator conversation appears on the
   right of the project page (a real DSH session with a composer); the
   coordinator prompt has already been sent, so continue the conversation there
   and let it split the work into tasks.
4. Back on the project page: in manual mode, click a task row to open its detail
   view, click **Approve**, then ask the coordinator to "dispatch the approved
   tasks".
5. When a worker finishes, its task moves into the `review` group; click the row
   to see the worker's conversation in the detail view (the output is its final
   message). **Resolve** at the top right means "this task counts as done": it
   writes `status: "resolved"`, and clicking it again takes the acceptance back
   to `review`. Delete lives in the row's right-click menu: the first stage
   offers only **Delete**, the second stage offers **Delete task only** or
   **Delete and archive session** (the latter only when the task has a worker
   session).
6. Settings and archiving are both in the gear dialog in column 2's header: save
   after editing; archiving is the last section of the **General** group (below
   **Threads**) and needs two clicks.

### How to uninstall

Disable or remove **Projects** (`@fatwang2/dsh-projects`) on the Plugins page. No
data is deleted — it stays under `$DSH_HOME/projects`; delete that directory by
hand if you want it gone.
