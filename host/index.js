/**
 * Projects — Host half.
 *
 * A project is a durable container for one goal: instructions, a workspace, a
 * shared memory, and a board of tasks. The Host half owns the data (under
 * `$DSH_HOME/projects/<id>/`), answers the browser page through same-origin
 * `/projects-api/*` routes, and exposes the same operations to the agent as
 * `projects_*` tools so one coordinator session can plan, dispatch and collect
 * results.
 *
 * Dispatch is the coordinator/worker seam: `projects_dispatch` starts a local
 * subagent (the worker) with a prompt composed from the project instructions,
 * an index of the shared memory and the task brief. The worker runs in the project
 * workspace; `subagent/end` writes its final message back onto the task as the
 * delivered output. The coordinator never executes a task itself.
 *
 * Data layout:
 *   $DSH_HOME/projects/<projectId>/project.json          project + tasks
 *   $DSH_HOME/projects/<projectId>/memory/MEMORY.md      generated memory index
 *   $DSH_HOME/projects/<projectId>/memory/<name>.md      one memory topic
 *   $DSH_HOME/projects/<projectId>/memory/archive/       whole files moved out
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

export const inject = ['webServer', 'tools']

const ROUTE = '/projects-api'
const BODY_LIMIT = 2 * 1024 * 1024
const MAX_GOAL = 16_000
const MAX_BRIEF = 8_000
const MAX_OUTPUT = 4_000
/**
 * Healthy size of the shared memory. Writes past this still succeed — silently
 * dropping a worker's findings would be worse than a fat memory — but the tool
 * result says so, and auto-compaction archives the oldest whole files, so the
 * project cannot grow it forever by accident.
 */
const MEMORY_BUDGET = 64_000
/**
 * Absolute ceiling for one memory file's body. This is a runaway guard, not the
 * budget: it has to stay above whatever is already on disk, because slicing a
 * file at a value below its current size would delete stored memory. The page
 * saves one file at a time through `POST /projects/:id/memory`, so a ceiling
 * under a file's current size would also make that file unsaveable.
 */
const MAX_MEMORY = 200_000
/** Bounds for the per-project `memoryBudget` override. */
const MEMORY_BUDGET_MIN = 4_000
const MEMORY_BUDGET_MAX = MAX_MEMORY
/**
 * Compaction aims *below* the budget rather than at it, so a project does not
 * re-compact on the very next write. 60% of the budget leaves room for roughly
 * a dozen normal-sized topic files.
 */
const MEMORY_TARGET_RATIO = 0.6
/**
 * Hard cap on the memory index injected into a worker prompt. The prompt has to
 * stay small no matter how large the memory grows, so the index is truncated
 * rather than the prompt.
 *
 * 4,000, not 2,000, because the prompt index must keep its one-line
 * descriptions: they are the only part that lets a worker tell two long,
 * similarly named files apart, and dropping them defeats the index. Measured on
 * this project's real memory after the per-file migration (21 files, long
 * Chinese names and descriptions): the full format is ~3,400 characters, so a
 * 2,000 cap forced the ladder down to "no description". The project's
 * `memoryBudget` is 64,000 characters, and a budget-full memory of ~20 files
 * still renders a full index under 4,000. This is a cap, not a target: the
 * ladder below still degrades deterministically when a memory outgrows it.
 */
const MEMORY_INDEX_LIMIT = 4_000
/** The same index for the tool: the discovery path may be a little longer. */
const MEMORY_INDEX_TOOL_LIMIT = 8_000
/**
 * The index's one-line description is a file's frontmatter description (or, when
 * it has none, the first non-empty body line), markdown stripped and cut at this
 * many characters. Long enough to tell two files apart, short enough that a full
 * index stays cheap.
 */
const MEMORY_DESCRIPTION_MAX = 80
/** Search lists at most this many files; the rest are counted, not listed. */
const MEMORY_SEARCH_LIMIT = 10
/**
 * A file whose name, description or first line contains one of these markers is
 * history rather than current fact. It stays readable by name, but the index and
 * search hide it so a superseded decision cannot be mistaken for the live one.
 */
const MEMORY_STALE_MARKERS = ['[superseded]', '[archived]']
const MAX_TASKS = 200
const MAX_MODEL = 200
const MAX_PRESET = 120
const MAX_EFFORT = 60
/**
 * Upper bound on `project.concurrency`, the number of workers this plugin will
 * admit at once for one project. Kept as one constant so the clamp, the update
 * path and the tool schema cannot drift apart.
 *
 * This is deliberately 8, matching the host subagent runtime's
 * `maxActiveSubagents` pool default, so the plugin never admits a worker the
 * host would refuse. It is still *our* ceiling: raising this constant does not
 * raise that pool.
 */
const MAX_CONCURRENCY = 8
/**
 * Per-task git worktree isolation (opt-in through `project.worktreeIsolation`).
 *
 * A task that gets a worktree runs in `<workspace>/.worktrees/<taskId>` on
 * branch `task/<taskId>`, so two workers of the same project cannot overwrite
 * each other's files. The worktree is retained after the worker settles (the
 * human reviews and merges it), and removed when the task is deleted or the
 * project is archived.
 *
 * `.worktrees/` must already be ignored by the repository: creating it in a
 * repository that does not ignore it would leave an untracked directory in
 * `git status`, which is exactly the kind of silent pollution this feature
 * must not cause. Dispatch refuses with an actionable error instead, and no
 * artifact is created.
 */
const WORKTREE_DIR = '.worktrees'
const WORKTREE_BRANCH_PREFIX = 'task/'
/**
 * A task id is used as one path segment and as the branch suffix, so it must be
 * a plain slug. Real ids are `t-` plus eight hex digits; the wider pattern keeps
 * a hand-written or legacy id usable without ever allowing `/`, `..` or a
 * leading `-` to escape the pool or be read as a git option.
 */
const WORKTREE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** One git command may take this long; a hung credential prompt must not hang dispatch. */
const GIT_TIMEOUT_MS = 120_000
const GIT_MAX_BUFFER = 8 * 1024 * 1024
/**
 * Git selector variables are inherited from the host process. A stale
 * `GIT_DIR`/`GIT_WORK_TREE` would make every command below operate on the wrong
 * repository, so they are removed from the child environment.
 */
const GIT_UNSET_KEYS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
]
/**
 * The one task-status enum. `status` is written by the host itself (add →
 * queued, dispatch → running, settle → review|failed), by the coordinator tool
 * (blocked, retry, and the human verdict when it relays one), and — for exactly
 * two values — by the page: `resolved` accepts the task, `review` takes that
 * acceptance back.
 *
 * There is deliberately no second `resolved` boolean: two dimensions for one
 * question ("is this task finished?") drifted apart, and the board counted
 * accepted work as outstanding. The enum is single-valued, so a task is in
 * exactly one bucket and every reader agrees on which.
 */
const STATUSES = ['queued', 'running', 'review', 'failed', 'blocked', 'resolved']
/** The single task field the browser is allowed to write. */
const HUMAN_TASK_FIELDS = ['status']
/** The only two statuses the page may write: accept, or take the acceptance back. */
const HUMAN_STATUSES = ['resolved', 'review']
const AUTONOMY = ['manual', 'auto']
/**
 * What `DELETE /projects-api/projects/:id/tasks/:taskId?session=` may do to the
 * worker session behind the task.
 *
 * Only `archive` exists, because DeepSeek Harness has no session deletion at
 * all. `sessions` (the `SessionStore`) offers create/prepare/enter/announce/
 * get/list/fork/flush and `sessionPersistence` offers create/open/read/append/
 * flush/stat/list — no method removes a stored log — and the product states the
 * gap outright ("sessions can be archived but are never deleted",
 * `dsh-client-ui-workspace/README.zh.md`). Reaching under those services to
 * `rm -rf $DSH_HOME/sessions/<cwd>/<id>/` would strand the workspace accounting
 * in `workspace.json`, the `session_projcache` projection cache and the archive
 * set, and would silently truncate the log of a session that is still live in
 * memory. So a delete request is refused with an explanation instead of being
 * quietly downgraded to an archive.
 */
const SESSION_ACTIONS = ['archive']
/** The delete action's refusal: explicit, and it names the supported one. */
const SESSION_DELETE_REFUSED =
  'DeepSeek Harness cannot delete a session — sessions can be archived but never deleted. '
  + 'Use ?session=archive to archive the worker session, or drop the parameter to delete only the task. '
  + 'The task was not deleted.'
/** Delete-action spellings that mean "remove the session", all of which refuse. */
const SESSION_DELETE_SPELLINGS = ['1', 'true', 'delete', 'remove', 'yes']
/** Live dispatch controllers, so unloading the plugin stops its workers. */
const controllers = new Map()
/**
 * Projects whose memory is being compacted right now. Compaction is
 * single-flight per project: a second write that lands mid-run must not start a
 * second pass over the same directory (two passes could archive the same file
 * twice and could interleave their moves). The entry is cleared in a `finally`,
 * so a failed run never wedges the project.
 */
const compacting = new Set()

// ---------------------------------------------------------------------------
// Paths and small helpers

function dshHome() {
  return process.env.DSH_HOME || join(process.env.HOME || homedir(), '.dsh')
}

function rootDir() {
  return join(dshHome(), 'projects')
}

function projectDir(id) {
  return join(rootDir(), id)
}

function projectFile(id) {
  return join(projectDir(id), 'project.json')
}

/**
 * The memory directory: one markdown file per topic plus the generated
 * `MEMORY.md` index. `archive/` holds whole files moved out by compaction.
 */
function memoryDir(id) {
  return join(projectDir(id), 'memory')
}

/** The generated index: one line per topic file. Rewritten on every mutation. */
function memoryIndexFile(id) {
  return join(memoryDir(id), MEMORY_INDEX_FILE)
}

/** Whole topic files moved out of the live memory by auto-compaction. */
function memoryArchiveDir(id) {
  return join(memoryDir(id), 'archive')
}

/**
 * The pre-per-file memory: one append-only `memory.md` with `## ` sections. Read
 * only by the migration, which renames it to `memory.bak.md` so the migration is
 * idempotent (a second run finds no `memory.md`) and manually reversible.
 */
function memoryFile(id) {
  return join(projectDir(id), 'memory.md')
}

/** The legacy archive beside `memory.md`; migration moves it into `archive/`. */
function memoryArchiveFile(id) {
  return join(projectDir(id), 'memory-archive.md')
}

/** The legacy memory as it was just before migration, for manual recovery. */
function memoryBackupFile(id) {
  return join(projectDir(id), 'memory.bak.md')
}

function newId(prefix) {
  return `${prefix}-${randomBytes(4).toString('hex')}`
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function intIn(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.round(number), min), max)
}

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/**
 * A stored model selection: `provider/model` when the provider is known (exactly
 * the `id` `GET /projects-api/models` advertises), or a bare model id that
 * inherits the parent Agent's provider. Empty means "use the host default", so a
 * non-string or blank value normalizes to '' rather than to a bogus route.
 */
function modelValue(value) {
  return text(value, MAX_MODEL).trim()
}

/** A stored agent-preset id; empty means "inherit the parent's composition". */
function presetValue(value) {
  return text(value, MAX_PRESET).trim()
}

/**
 * A stored reasoning effort. Efforts are *provider-owned opaque ids* — the LLM
 * layer brands them `ReasoningEffortId` but never enumerates them globally, so
 * this is deliberately a free string, not a fixed enum: DeepSeek advertises
 * `off|low|high|max`, another adapter may advertise `minimal|medium|xhigh`.
 * Empty means "let the provider apply its own default", so a non-string or blank
 * value normalizes to '' rather than to a bogus level.
 *
 * The page learns the legal values per model from `GET /projects-api/models`
 * (`models[].efforts`); dispatch does not pre-validate, because the catalog is
 * advisory and a stale list must not block a dispatch the provider would accept.
 */
function effortValue(value) {
  return text(value, MAX_EFFORT).trim()
}

/**
 * Translate a stored selection into the `agentOptions` route the subagent
 * service expects. The first `/` separates provider from model, so a model id
 * that itself contains a slash (`siliconflow/deepseek-ai/DeepSeek-V3`) survives
 * intact. A bare id yields no provider, which makes the child inherit the
 * parent's route for that half.
 *
 * @returns the route, or undefined when nothing is selected (callers must then
 * omit `agentOptions` entirely instead of sending an empty object).
 */
function modelRoute(value) {
  const raw = modelValue(value)
  if (!raw) return undefined
  const slash = raw.indexOf('/')
  if (slash > 0 && slash < raw.length - 1) {
    return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
  }
  return { model: raw }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function writeFileAtomic(file, contents) {
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, contents, 'utf8')
  await rename(temporary, file)
}

// ---------------------------------------------------------------------------
// Store

function normalizeTask(raw) {
  // Two legacy shapes collapse into the single status enum on read:
  //   - `status: 'done'`, the pre-status-only marker for "the human accepted it";
  //   - `resolved: true` beside a system status, the boolean this model retires.
  // Both become `status: 'resolved'`, and `resolved` is simply not copied over —
  // normalizeTask builds a fresh row, so the field disappears from memory at once
  // and from disk on the next write.
  const accepted = raw.status === 'done' || raw.resolved === true
  const task = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('t'),
    title: text(raw.title, 200) || 'Untitled task',
    brief: text(raw.brief, MAX_BRIEF),
    status: accepted ? 'resolved' : STATUSES.includes(raw.status) ? raw.status : 'queued',
    approved: raw.approved === true,
    output: text(raw.output, MAX_OUTPUT),
    // Empty means "inherit the project default", which in turn may be empty and
    // mean "use the host default"; dispatch resolves the chain.
    model: modelValue(raw.model),
    agentPreset: presetValue(raw.agentPreset),
    reasoningEffort: effortValue(raw.reasoningEffort),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  }
  if (typeof raw.childSessionId === 'string' && raw.childSessionId) task.childSessionId = raw.childSessionId
  if (typeof raw.childName === 'string' && raw.childName) task.childName = raw.childName
  if (typeof raw.stopReason === 'string' && raw.stopReason) task.stopReason = raw.stopReason
  // Worktree isolation is recorded on the task that ran: the branch and the
  // checkout path when it succeeded, and a reason code plus a sentence when the
  // project asked for isolation but the workspace could not provide it.
  if (typeof raw.branch === 'string' && raw.branch) task.branch = text(raw.branch, 200)
  if (typeof raw.worktreePath === 'string' && raw.worktreePath) task.worktreePath = text(raw.worktreePath, 1024)
  if (typeof raw.worktreeDegraded === 'string' && raw.worktreeDegraded) {
    task.worktreeDegraded = text(raw.worktreeDegraded, 60)
  }
  if (typeof raw.worktreeNote === 'string' && raw.worktreeNote) task.worktreeNote = text(raw.worktreeNote, 600)
  if (Number(raw.startedAt)) task.startedAt = Number(raw.startedAt)
  if (Number(raw.finishedAt)) task.finishedAt = Number(raw.finishedAt)
  return task
}

function normalizeProject(raw) {
  return {
    version: 1,
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('p'),
    name: text(raw.name, 120) || 'Untitled project',
    goal: text(raw.goal, MAX_GOAL),
    workspace: text(raw.workspace, 1024),
    autonomy: AUTONOMY.includes(raw.autonomy) ? raw.autonomy : 'manual',
    concurrency: intIn(raw.concurrency, 1, MAX_CONCURRENCY, 2),
    archived: raw.archived === true,
    // Opt-in: every worker of this project gets its own git worktree and branch
    // when the workspace is a git repository. Off is the historical behavior.
    worktreeIsolation: raw.worktreeIsolation === true,
    // The default route every worker of this project starts on. Empty means the
    // host default; a task may override it.
    model: modelValue(raw.model),
    agentPreset: presetValue(raw.agentPreset),
    reasoningEffort: effortValue(raw.reasoningEffort),
    // Automatic memory compaction: on by default, because an unbounded memory
    // file is the failure mode this feature exists to prevent. `memoryBudget` is
    // the per-project threshold; the module default applies when it is absent.
    autoCompact: raw.autoCompact !== false,
    memoryBudget: intIn(raw.memoryBudget, MEMORY_BUDGET_MIN, MEMORY_BUDGET_MAX, MEMORY_BUDGET),
    ...(raw.lastCompaction && typeof raw.lastCompaction === 'object'
      ? {
        lastCompaction: {
          at: Number(raw.lastCompaction.at) || 0,
          before: Number(raw.lastCompaction.before) || 0,
          after: Number(raw.lastCompaction.after) || 0,
          archived: Number(raw.lastCompaction.archived) || 0,
        },
      }
      : {}),
    ...(typeof raw.coordinatorSessionId === 'string' && raw.coordinatorSessionId
      ? { coordinatorSessionId: raw.coordinatorSessionId }
      : {}),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    tasks: Array.isArray(raw.tasks) ? raw.tasks.slice(0, MAX_TASKS).map(normalizeTask) : [],
  }
}

async function readProject(id) {
  if (!/^p-[0-9a-f]{8}$/.test(String(id))) throw httpError(404, 'project_not_found')
  let raw
  try {
    raw = await readFile(projectFile(id), 'utf8')
  } catch {
    throw httpError(404, 'project_not_found')
  }
  try {
    return normalizeProject(JSON.parse(raw))
  } catch {
    throw httpError(500, 'project_unreadable')
  }
}

async function writeProject(project) {
  await mkdir(projectDir(project.id), { recursive: true })
  await writeFileAtomic(projectFile(project.id), `${JSON.stringify(project, null, 2)}\n`)
}

async function listProjects() {
  let entries
  try {
    entries = await readdir(rootDir(), { withFileTypes: true })
  } catch {
    return []
  }
  const projects = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      projects.push(await readProject(entry.name))
    } catch {
      // A half-written or foreign directory must not break the board.
    }
  }
  projects.sort((left, right) => right.updatedAt - left.updatedAt)
  return projects
}

// ---------------------------------------------------------------------------
// Shared memory: one markdown file per topic
//
// The memory used to be a single append-only `memory.md` split into `## `
// sections. It is now a directory of one file per topic, each with frontmatter:
//
//   $DSH_HOME/projects/<id>/memory/MEMORY.md          generated index
//   $DSH_HOME/projects/<id>/memory/<name>.md          one topic
//   $DSH_HOME/projects/<id>/memory/archive/<name>.md  whole files moved out
//
// Why: one file only ever grows, so every append rewrote all of it and
// compaction had to cut it at a section boundary. One file per topic makes
// "archive the oldest knowledge" a whole-file move (nothing is ever split) and
// lets a reader fetch exactly the topic it needs. The index is generated, never
// hand-edited: every mutation rewrites `MEMORY.md`, and the dispatch prompt
// injects the same index (bounded by `MEMORY_INDEX_LIMIT`, with the same
// degradation ladder).

/** The generated index file inside the memory directory. Never a topic file. */
const MEMORY_INDEX_FILE = 'MEMORY.md'
/**
 * Longest slug used as a file name. A 60-character Chinese slug is 180 UTF-8
 * bytes, so the file name stays under the 255-byte limit; it is also short
 * enough that a full index of ~20 files still fits the prompt cap.
 */
const MEMORY_NAME_MAX = 60
/** Longest `type:` value accepted in frontmatter. */
const MEMORY_TYPE_MAX = 40

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function statOrNull(path) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/**
 * Move a file, falling back to copy+unlink when source and destination are on
 * different filesystems (rename is atomic and the only lossless option
 * otherwise).
 */
async function moveFile(from, to) {
  try {
    await rename(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await writeFile(to, await readFile(from))
    await rm(from, { force: true })
  }
}

/**
 * A memory file name: lower-case, hyphen-separated, with Unicode letters and
 * digits kept so a Chinese title survives into the file name. Capped at
 * `MEMORY_NAME_MAX` characters.
 */
function memorySlug(value) {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return Array.from(slug).slice(0, MEMORY_NAME_MAX).join('').replace(/-+$/g, '')
}

/**
 * A name with a `-2`, `-3` suffix when the slug is already taken. Never returns
 * the reserved index name (`memory`), so a section titled "Memory" — or a title
 * that slugifies to nothing — still becomes a real topic file.
 */
function uniqueMemoryName(used, base) {
  let name = String(base ?? '').trim() || 'memory-topic'
  if (name === 'memory') name = 'memory-topic'
  if (!used.has(name)) return name
  for (let index = 2; index < 1_000; index += 1) {
    const suffix = `-${index}`
    const candidate = `${name.slice(0, MEMORY_NAME_MAX - suffix.length)}${suffix}`
    if (!used.has(candidate)) return candidate
  }
  return `${name.slice(0, 40)}-${randomBytes(3).toString('hex')}`
}

/** The name a caller asked for, or '' when none was given. */
function memoryNameOf(value) {
  const raw = text(value, 300).trim().replace(/\.md$/i, '')
  if (!raw) return ''
  return memorySlug(raw)
}

/** The name a write/delete caller asked for; throws when it is unusable. */
function memoryNameOrThrow(value) {
  const raw = text(value, 300).trim()
  if (!raw) {
    throw httpError(400, 'name is required for this action (a memory file name such as "deployment-notes")')
  }
  const name = memorySlug(raw.replace(/\.md$/i, ''))
  if (!name) throw httpError(400, `"${raw}" is not a valid memory file name`)
  if (name === 'memory') {
    throw httpError(400, 'MEMORY.md is the generated index, not a topic file; pick another name')
  }
  return name
}

/**
 * Strip the markdown that would otherwise spend index characters on syntax:
 * heading hashes, list bullets, blockquote markers, bold markers and code
 * backticks. Deliberately shallow — a description is a hint, not a rendering.
 */
function plainMemoryLine(line) {
  return String(line ?? '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** One frontmatter description: markdown stripped, one line, capped. */
function memoryDescriptionLine(value) {
  const plain = plainMemoryLine(value)
  if (!plain) return ''
  return plain.length > MEMORY_DESCRIPTION_MAX
    ? `${plain.slice(0, MEMORY_DESCRIPTION_MAX).trimEnd()}…`
    : plain
}

/** The index's one-line description: the first non-empty body line. */
function memoryDescription(body) {
  const first = String(body ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!first) return ''
  return memoryDescriptionLine(first)
}

/** A `type:` value: one line, bounded, defaulting to "reference". */
function memoryTypeOf(value) {
  const plain = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MEMORY_TYPE_MAX)
  return plain || 'reference'
}

/** The `YYYY-MM-DD` date a `modified` timestamp carries, or ''. */
function memoryDateOf(modified) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(modified ?? ''))
  return match ? match[1] : ''
}

/** The `YYYY-MM-DD` date a legacy section title carries, or ''. */
function memoryDate(title) {
  const match = /\b(\d{4}-\d{2}-\d{2})\b/.exec(String(title ?? ''))
  return match ? match[1] : ''
}

/**
 * True for a file whose name, description or first body line marks it as
 * history rather than current fact. Titles carried the `[superseded]` marker
 * before the migration; a slug cannot hold brackets, so a whole hyphen-delimited
 * `superseded`/`archived` token in the name means the same thing.
 */
function isStaleMemoryFile(file) {
  const first = String(file.body ?? '').split('\n').find((line) => line.trim()) || ''
  const haystack = `${file.name}\n${file.description}\n${first}`.toLowerCase()
  if (MEMORY_STALE_MARKERS.some((marker) => haystack.includes(marker))) return true
  return /(^|-)(superseded|archived)(-|$)/.test(String(file.name ?? '').toLowerCase())
}

/** Split frontmatter from the body. Returns null when the file has none. */
function readMemoryFrontmatter(raw) {
  const source = String(raw ?? '')
  if (!source.startsWith('---\n')) return null
  const end = source.indexOf('\n---', 4)
  if (end === -1) return null
  const fields = {}
  for (const line of source.slice(4, end).split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1)
    }
    fields[match[1].toLowerCase()] = value
  }
  const body = source.slice(end + 4).replace(/^\n+/, '').replace(/\n+$/, '')
  return { fields, body }
}

/**
 * Parse one memory file. A file without frontmatter is still a topic file: the
 * name comes from the file name, the description from the first line and
 * `modified` from its mtime (filled in by `listMemoryFiles`), so a hand-written
 * file is never invisible.
 */
function parseMemoryFile(raw, fallback = {}) {
  const source = String(raw ?? '')
  const fileName = String(fallback.name ?? '')
  // A hand-written file has no frontmatter to delimit the body, so its body is
  // the whole file minus the trailing newlines (the same shape a serialized file
  // parses back to).
  const body = source.replace(/\n+$/, '')
  const file = {
    name: fileName,
    fileName,
    description: '',
    type: 'reference',
    modified: '',
    body,
    chars: body.length,
    path: String(fallback.path ?? ''),
  }
  const frontmatter = readMemoryFrontmatter(source)
  if (frontmatter) {
    const fields = frontmatter.fields
    if (fields.name) file.name = memorySlug(fields.name) || fileName
    if (fields.description) file.description = memoryDescriptionLine(fields.description)
    if (fields.type) file.type = memoryTypeOf(fields.type)
    if (fields.modified && !Number.isNaN(Date.parse(fields.modified))) {
      file.modified = new Date(fields.modified).toISOString()
    }
    file.body = frontmatter.body
    file.chars = file.body.length
  }
  if (!file.description) file.description = memoryDescription(file.body) || file.name
  file.stale = isStaleMemoryFile(file)
  return file
}

/** Serialize one memory file: frontmatter, a blank line, then the body. */
function serializeMemoryFile(file) {
  const body = String(file.body ?? '').replace(/\n+$/, '')
  return [
    '---',
    `name: ${file.name}`,
    `description: ${file.description}`,
    `type: ${file.type || 'reference'}`,
    `modified: ${file.modified}`,
    '---',
    '',
    body,
    '',
  ].join('\n')
}

/**
 * The timestamp a write stamps on its file. Kept monotonic per project so two
 * writes in the same millisecond still have a deterministic order (the index,
 * and therefore compaction, is ordered by `modified`).
 */
function nextMemoryModified(files) {
  const now = Date.now()
  let newest = 0
  for (const file of files) {
    const parsed = Date.parse(file.modified)
    if (Number.isFinite(parsed) && parsed > newest) newest = parsed
  }
  return new Date(Math.max(now, newest + 1)).toISOString()
}

/** Code-unit order, so the index and compaction order never depend on a locale. */
function compareText(left, right) {
  const a = String(left ?? '')
  const b = String(right ?? '')
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Oldest first, then by name: the order compaction archives in. */
function compareMemoryFiles(left, right) {
  return compareText(left.modified, right.modified) || compareText(left.name, right.name)
}

/** The characters one project's memory holds: body text, not frontmatter. */
function memoryTotal(files) {
  return files.reduce((total, file) => total + file.chars, 0)
}

/**
 * List the topic files in one memory directory. `MEMORY.md` is the generated
 * index, not a topic, so it is never listed; a directory (the archive) is not a
 * file. Files are parsed and sorted oldest first.
 */
async function listMemoryFiles(id, dir = memoryDir(id)) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = entries.filter(
    (entry) =>
      entry.isFile()
      && /\.md$/i.test(entry.name)
      && entry.name.toLowerCase() !== MEMORY_INDEX_FILE.toLowerCase(),
  )
  const files = await Promise.all(
    candidates.map(async (entry) => {
      const path = join(dir, entry.name)
      const fileName = entry.name.replace(/\.md$/i, '')
      let raw
      try {
        raw = await readFile(path, 'utf8')
      } catch {
        return null
      }
      const file = parseMemoryFile(raw, { name: fileName, path })
      if (!file.modified) {
        const info = await statOrNull(path)
        file.modified = new Date(info ? info.mtimeMs : Date.now()).toISOString()
      }
      return file
    }),
  )
  return files.filter(Boolean).sort(compareMemoryFiles)
}

/** The archived topic files: whole files moved out by compaction. */
async function listArchiveFiles(id) {
  return listMemoryFiles(id, memoryArchiveDir(id))
}

/** One index line at the requested level of detail. */
function memoryIndexEntry(file, mode) {
  if (mode === 'titles') return `· ${file.name}`
  const size = `${file.chars} chars`
  const date = memoryDateOf(file.modified)
  const suffix = date ? `，${date}` : ''
  if (mode === 'no-description' || !file.description) return `· ${file.name}（${size}${suffix}）`
  return `· ${file.name} — ${file.description}（${size}${suffix}）`
}

/**
 * The "marked stale" footnote: names only, never descriptions, because these
 * files are history. Bounded so a project with dozens of them cannot blow the
 * index on its own.
 */
function staleMemoryLine(stale) {
  const names = stale.map((file) => file.name).join(' | ')
  let line = `- ${stale.length} file(s) marked stale (superseded/archived; still readable by name): ${names}`
  if (line.length > 500) line = `${line.slice(0, 500).trimEnd()}…`
  return line
}

/**
 * The memory as an index: one line per file with a one-line description, its
 * size and its modification date — never the body. This is what a worker prompt
 * gets, so the prompt stays bounded no matter how much history accumulates.
 *
 * A described index is longer than a bare name list, so the format degrades in
 * a fixed order until it fits `limit`:
 *
 *   1. name + description + size + date      (full)
 *   2. name + size + date                    (descriptions dropped)
 *   3. name only                             (sizes and dates dropped)
 *   4. name only, truncated                  (whole files dropped + counted)
 *
 * The first level whose text fits wins, and the header names the level in use.
 * Files whose name/description marks them `[superseded]`/`[archived]` are left
 * out of the list. `listStale` adds the "marked stale" footnote (names only) —
 * the tool's index action asks for it so a coordinator can still find history by
 * name; the worker prompt does not, because workers act on current knowledge.
 */
function memoryIndex(files, limit = MEMORY_INDEX_LIMIT, { listStale = false } = {}) {
  const all = Array.isArray(files) ? files : []
  if (all.length === 0) return '(empty)'
  const live = all.filter((file) => !file.stale)
  const stale = all.filter((file) => file.stale)
  const header =
    `${live.length} file(s), ${memoryTotal(all)} characters. ` +
    'Read one with projects_memory {action:"read", name:"<name>"} — do not assume you know what a file says. ' +
    'Find one with projects_memory {action:"search", query:"<keyword>"}.'
  const staleLine = listStale && stale.length ? staleMemoryLine(stale) : ''
  const levels = [
    { mode: 'full', note: '' },
    { mode: 'no-description', note: ` Descriptions omitted to fit the ${limit}-character index cap.` },
    {
      mode: 'titles',
      note: ` Titles only (descriptions and sizes omitted) to fit the ${limit}-character index cap.`,
    },
  ]
  for (const level of levels) {
    const lines = [`${header}${level.note}`]
    for (const file of live) lines.push(memoryIndexEntry(file, level.mode))
    if (staleLine) lines.push(staleLine)
    const candidate = lines.join('\n')
    if (candidate.length <= limit) return candidate
  }
  // Level 4. Reserve room for the "…and N more" note so the note itself cannot
  // push the result past the cap; the truncated header is longer than level 3's,
  // so this branch always drops at least one file.
  const truncatedHeader = `${header} Titles only (descriptions and sizes omitted), truncated to fit the ${limit}-character index cap.`
  const fixedLength = truncatedHeader.length + (staleLine ? staleLine.length + 1 : 0)
  const room = Math.max(0, limit - fixedLength - 2 - 200)
  const shown = []
  let used = 0
  for (const file of live) {
    const entry = memoryIndexEntry(file, 'titles')
    if (used + entry.length + 1 > room) break
    shown.push(entry)
    used += entry.length + 1
  }
  const omitted = live.length - shown.length
  const lines = [truncatedHeader]
  lines.push(...shown)
  if (omitted > 0) lines.push(`- …and ${omitted} more file(s) not listed (index capped at ${limit} characters).`)
  if (staleLine) lines.push(staleLine)
  return lines.join('\n')
}

/**
 * Find files by keyword: case-insensitive substring match over the name, the
 * description and the body, stale files excluded. Returns names, one-line
 * descriptions and sizes — never bodies — so a search costs a fraction of a read.
 */
function searchMemory(files, query, limit = MEMORY_SEARCH_LIMIT) {
  const needle = String(query ?? '').trim()
  if (!needle) throw new Error('query is required for action "search"')
  const all = Array.isArray(files) ? files : []
  if (all.length === 0) return `No memory file matches "${needle}". The shared memory is empty.`
  const live = all.filter((file) => !file.stale)
  const wanted = needle.toLowerCase()
  const matches = live.filter(
    (file) =>
      file.name.toLowerCase().includes(wanted)
      || file.description.toLowerCase().includes(wanted)
      || file.body.toLowerCase().includes(wanted),
  )
  if (matches.length === 0) {
    const stale = all.length - live.length
    return (
      `No memory file matches "${needle}". ${live.length} live file(s) in memory` +
      `${stale ? `, ${stale} stale file(s) excluded` : ''} — ` +
      'use projects_memory {action:"index"} to see them all.'
    )
  }
  const shown = matches.slice(0, limit)
  const header =
    `${matches.length} file(s) match "${needle}"` +
    (shown.length < matches.length ? `, showing the first ${shown.length}` : '') +
    '. Read one with projects_memory {action:"read", name:"<name>"}.'
  const lines = [header, ...shown.map((file) => memoryIndexEntry(file, 'full'))]
  if (shown.length < matches.length) {
    lines.push(`- …and ${matches.length - shown.length} more file(s) match; narrow the query or use action:"index".`)
  }
  return lines.join('\n')
}

/**
 * Find one file by name. Deliberately forgiving: exact match first, then
 * prefix, then "contains", all case-insensitive, because callers copy names by
 * hand and often shorten them. Both the frontmatter name and the file name are
 * matched, so a hand-edited frontmatter cannot hide a file.
 */
function findMemoryFile(files, needle) {
  const wanted = memoryNameOf(needle)
  if (!wanted) return null
  const names = (file) =>
    [file.name, file.fileName].filter(Boolean).map((value) => String(value).toLowerCase())
  return (
    files.find((file) => names(file).includes(wanted))
    || files.find((file) => names(file).some((value) => value.startsWith(wanted)))
    || files.find((file) => names(file).some((value) => value.includes(wanted)))
    || null
  )
}

/** The generated index file's text: the full index, never truncated. */
function renderMemoryIndexFile(files) {
  return `# Shared memory index\n\n${memoryIndex(files, Number.POSITIVE_INFINITY, { listStale: true })}\n`
}

/** Rewrite `MEMORY.md` from the files on disk. Every mutation calls this. */
async function writeMemoryIndex(id, files) {
  const ordered = [...files].sort(compareMemoryFiles)
  await mkdir(memoryDir(id), { recursive: true })
  await writeFileAtomic(memoryIndexFile(id), renderMemoryIndexFile(ordered))
}

/**
 * Split a legacy `memory.md` into preamble + `## ` sections, keeping each
 * section's title and body text verbatim.
 */
function splitLegacyMemory(raw) {
  const blocks = []
  const preamble = []
  let current = null
  for (const line of String(raw ?? '').split('\n')) {
    if (line.startsWith('## ')) {
      if (current) blocks.push(current)
      current = { title: line.slice(3).trim(), lines: [] }
      continue
    }
    if (current) current.lines.push(line)
    else preamble.push(line)
  }
  if (current) blocks.push(current)
  const result = []
  const pre = preamble.join('\n').trim()
  if (pre) result.push({ title: null, body: pre })
  for (const block of blocks) {
    result.push({ title: block.title, body: block.lines.join('\n').trim() })
  }
  return result
}

/**
 * Migrate the pre-per-file `memory.md` into one file per `## ` section.
 *
 * Rules:
 *  - the title becomes the name (slug), the first body line the description,
 *    and the date in the title the initial `modified`, plus one second per
 *    document position so the append order survives as modified order;
 *  - the title itself is kept as the body's first line (`# <title>`), so no
 *    text is lost to slugging;
 *  - a preamble before the first heading becomes `preamble.md`;
 *  - the legacy `memory-archive.md` moves into `memory/archive/` verbatim;
 *  - `memory.md` is renamed to `memory.bak.md`, which makes the migration
 *    idempotent (a second run finds no `memory.md`) and manually reversible
 *    (`mv memory.bak.md memory.md` and remove `memory/`).
 */
async function migrateLegacyMemory(id, raw) {
  await mkdir(memoryDir(id), { recursive: true })
  await mkdir(memoryArchiveDir(id), { recursive: true })
  const blocks = splitLegacyMemory(raw)
  const info = await statOrNull(memoryFile(id))
  const fallback = info ? info.mtimeMs : Date.now()
  const used = new Set()
  const files = []
  blocks.forEach((block, index) => {
    const title = block.title || ''
    const name = uniqueMemoryName(used, title ? memorySlug(title) : 'preamble')
    used.add(name)
    const date = memoryDate(title)
    const base = date ? Date.parse(`${date}T00:00:00.000Z`) : fallback
    const modified = new Date(base + index * 1_000).toISOString()
    const body = title ? `# ${title}\n\n${block.body}`.trimEnd() : block.body
    files.push({
      name,
      fileName: name,
      description: memoryDescription(block.body) || memoryDescription(title) || name,
      type: 'reference',
      modified,
      body,
      chars: body.length,
      path: join(memoryDir(id), `${name}.md`),
    })
  })
  for (const file of files) await writeFileAtomic(file.path, serializeMemoryFile(file))
  if (await pathExists(memoryArchiveFile(id))) {
    await moveFile(memoryArchiveFile(id), await uniqueArchivePath(id, 'legacy-memory-archive'))
  }
  try {
    await rename(memoryFile(id), memoryBackupFile(id))
  } catch (error) {
    // Two readers can migrate the same project at once: the first rename wins,
    // the second finds no `memory.md` and the backup the first wrote is the one
    // to keep.
    if (error?.code !== 'ENOENT') throw error
  }
  await writeMemoryIndex(id, files)
  return { files: files.length, chars: memoryTotal(files) }
}

/** Migrate on first touch: a legacy `memory.md` is converted, then backed up. */
async function ensureMemoryMigrated(id) {
  let raw
  try {
    raw = await readFile(memoryFile(id), 'utf8')
  } catch {
    return false
  }
  await migrateLegacyMemory(id, raw)
  return true
}

/** The live memory files, migrating a legacy `memory.md` first. */
async function readMemoryFiles(id) {
  await ensureMemoryMigrated(id)
  const files = await listMemoryFiles(id)
  // Self-healing: the index is generated, so a deleted MEMORY.md comes back on
  // the next read instead of silently disappearing.
  if (files.length > 0 && !(await pathExists(memoryIndexFile(id)))) {
    try {
      await writeMemoryIndex(id, files)
    } catch {
      // The index file is a convenience for humans and external readers; a read
      // must still work when it cannot be regenerated.
    }
  }
  return files
}

/** One file by name, live first and then the archive. */
async function readMemoryFile(id, name) {
  const live = findMemoryFile(await readMemoryFiles(id), name)
  if (live) return { file: live, archived: false }
  const archived = findMemoryFile(await listArchiveFiles(id), name)
  return archived ? { file: archived, archived: true } : null
}

/** Write one topic file (create or replace) and regenerate the index. */
async function writeMemoryFile(id, input, knownFiles) {
  const files = knownFiles || (await readMemoryFiles(id))
  const existing = files.find((file) => file.name === input.name)
  const raw = String(input.text ?? '')
  const truncated = raw.length > MAX_MEMORY
  const body = (truncated ? raw.slice(0, MAX_MEMORY) : raw).replace(/\n+$/, '')
  const description =
    memoryDescriptionLine(input.description)
    || existing?.description
    || memoryDescription(body)
    || input.name
  const file = {
    name: input.name,
    fileName: input.name,
    description,
    type: memoryTypeOf(input.type || existing?.type),
    modified: nextMemoryModified(files),
    body,
    chars: body.length,
    path: join(memoryDir(id), `${input.name}.md`),
  }
  await mkdir(memoryDir(id), { recursive: true })
  await writeFileAtomic(file.path, serializeMemoryFile(file))
  const next = [...files.filter((candidate) => candidate.name !== file.name), file]
  await writeMemoryIndex(id, next)
  return { file, total: memoryTotal(next), count: next.length, truncated }
}

/** Append text to one topic file, creating it when it does not exist yet. */
async function appendMemoryFile(id, input) {
  const files = await readMemoryFiles(id)
  const existing = files.find((file) => file.name === input.name)
  const addition = String(input.text ?? '').trim()
  const body = existing && existing.body ? `${existing.body}\n\n${addition}` : addition
  return writeMemoryFile(id, { ...input, text: body }, files)
}

/** Delete one topic file and regenerate the index. Exact name only. */
async function deleteMemoryFile(id, name) {
  const files = await readMemoryFiles(id)
  const wanted = memoryNameOf(name)
  const file = files.find(
    (candidate) => candidate.name === wanted || candidate.fileName === wanted,
  )
  if (!file) {
    throw httpError(
      404,
      `No memory file matches "${name}". Files: ${files.map((candidate) => candidate.name).join(' | ') || '(none)'}.`,
    )
  }
  await rm(file.path, { force: true })
  const next = files.filter((candidate) => candidate.name !== file.name)
  await writeMemoryIndex(id, next)
  return { file, total: memoryTotal(next), count: next.length }
}

/** A unique path inside `memory/archive/` for a file being moved out. */
async function uniqueArchivePath(id, name) {
  const dir = memoryArchiveDir(id)
  const base = memorySlug(name) || 'memory'
  let candidate = join(dir, `${base}.md`)
  if (!(await pathExists(candidate))) return candidate
  const stamp = Date.now().toString(36)
  candidate = join(dir, `${base}-${stamp}.md`)
  let index = 2
  while (await pathExists(candidate)) {
    candidate = join(dir, `${base}-${stamp}-${index}.md`)
    index += 1
  }
  return candidate
}

/**
 * A bounded list of what compaction moved out, appended to the tool's index so
 * an archived file stays discoverable. Deliberately *not* part of the worker
 * prompt's index: workers act on current knowledge, and archived history is
 * something the coordinator looks up on purpose.
 */
function archiveSummary(files, limit = 2_000) {
  if (!files || files.length === 0) return ''
  const header =
    `${files.length} archived file(s) in memory/archive/ — moved out by compaction, not injected into prompts. ` +
    'Read one with action "read", name:"<name>".'
  const lines = [header]
  let used = header.length
  for (const file of files) {
    const entry = `- ${file.fileName || file.name} (${file.chars} chars)`
    if (used + entry.length + 1 > limit) {
      lines.push(`- …and ${files.length - (lines.length - 1)} more archived file(s) not listed.`)
      break
    }
    lines.push(entry)
    used += entry.length + 1
  }
  return lines.join('\n')
}

/** A warning suffix for memory writes, or '' when everything is fine. */
function memoryWarning({ length, truncated, name }, budget = MEMORY_BUDGET) {
  const notes = []
  if (truncated) {
    notes.push(
      `WARNING: memory file "${name}" hit the ${MAX_MEMORY}-character write ceiling and the tail was cut (only the tail: nothing before it was dropped).`,
    )
  }
  if (length > budget) {
    notes.push(
      `WARNING: the shared memory is now ${length} characters, ${length - budget} over the ${budget}-character budget. ` +
        'Workers only receive an index, but it should be compressed: read it with action "index", then rewrite or delete whole files, or let auto-compaction archive the oldest ones.',
    )
  }
  return notes.length ? ` ${notes.join(' ')}` : ''
}

// ---------------------------------------------------------------------------
// Automatic memory compaction
//
// The memory only ever grows. Workers get an index (never the text) and the
// coordinator reads one file at a time, so a fat memory is not fatal — but it
// does mean the project's durable knowledge is buried in a changelog, and every
// "read the whole memory" eventually costs a context window. So the host
// compacts on its own once the memory crosses the budget.
//
// This is deliberately *deterministic archiving*, not an LLM summarisation pass:
//
//  - A compaction worker cannot be started from most write paths. `startActivation`
//    needs `parent: Agent`, and the page's `POST /projects/:id/memory` has no
//    calling agent at all; a worker appending its findings is itself a depth-1
//    child, and the subagent runtime's `maxDepth` defaults to 1, so its child
//    would be refused (`subagent depth 2 exceeds maxDepth 1`). Those are exactly
//    the two paths that grow the memory.
//  - `delivery: 'parent'` is fire-and-forget: the compacted text would only come
//    back on `subagent/end`, i.e. after the write path returned, so it could not
//    be validated or rolled back inline and appends landing meanwhile would race.
//  - Moving whole files cannot lose a fact: the moved file is kept verbatim in
//    `memory/archive/`. A model rewrite can, and silently.
//
// So: whole oldest files move to `memory/archive/` until the live memory fits
// the target. Nothing is summarised, split or dropped.

/** The per-project budget, clamped so a hand-edited project.json cannot disable it. */
function memoryBudgetOf(project) {
  return intIn(project?.memoryBudget, MEMORY_BUDGET_MIN, MEMORY_BUDGET_MAX, MEMORY_BUDGET)
}

/**
 * Decide what to move. Keeps the newest files that fit `target` and archives the
 * older ones; the newest file is always kept even when it alone exceeds the
 * target, because a file is never split. Returns null when there is nothing safe
 * to move (no files, or only one).
 */
function planFileArchive(files, target) {
  if (!files || files.length <= 1) return null
  const kept = []
  let used = 0
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const file = files[index]
    if (kept.length > 0 && used + file.chars > target) break
    kept.unshift(file)
    used += file.chars
  }
  const moved = files.slice(0, files.length - kept.length)
  if (moved.length === 0) return null
  return { kept, moved }
}

/**
 * Compact one project's memory down to `MEMORY_TARGET_RATIO` of its budget.
 *
 * Whole files move into `memory/archive/`; nothing is split, summarised or
 * dropped. Order matters: plan → move → regenerate the index → verify. Any
 * failure after a move puts the moved files back, so a compaction can never be
 * the thing that loses memory.
 *
 * @returns a result object; `skipped` is null on success.
 */
async function compactMemory(projectId) {
  const id = String(projectId)
  if (compacting.has(id)) return { skipped: 'in_flight' }
  compacting.add(id)
  const moved = []
  let before = 0
  let budget = MEMORY_BUDGET
  try {
    const project = await readProject(id)
    budget = memoryBudgetOf(project)
    const files = await readMemoryFiles(id)
    before = memoryTotal(files)
    if (before <= budget) return { skipped: 'under_budget', before, after: before, budget }
    const target = Math.max(1, Math.floor(budget * MEMORY_TARGET_RATIO))
    const plan = planFileArchive(files, target)
    if (!plan) return { skipped: 'nothing_to_archive', before, after: before, budget }
    await mkdir(memoryArchiveDir(id), { recursive: true })
    for (const file of plan.moved) {
      const destination = await uniqueArchivePath(id, file.name)
      await moveFile(file.path, destination)
      moved.push({ file, target: destination })
    }
    await writeMemoryIndex(id, plan.kept)
    const after = memoryTotal(plan.kept)
    const check = await listMemoryFiles(id)
    const stillLive = plan.moved.filter((file) =>
      check.some((candidate) => candidate.fileName === file.fileName),
    )
    if (stillLive.length > 0) {
      throw new Error(
        `the moved file(s) are still in the live memory: ${stillLive.map((file) => file.name).join(', ')}`,
      )
    }
    const record = { at: Date.now(), before, after, archived: plan.moved.length }
    // Re-read before saving: compaction can run while a task settles, and a stale
    // copy would undo that write.
    const latest = await readProject(id)
    latest.lastCompaction = record
    latest.updatedAt = Date.now()
    await writeProject(latest)
    return { skipped: null, ...record, budget }
  } catch (error) {
    for (const { file, target } of [...moved].reverse()) {
      try {
        await moveFile(target, file.path)
      } catch {
        // The archive still holds the file; nothing is lost either way.
      }
    }
    if (moved.length > 0) {
      try {
        await writeMemoryIndex(id, await listMemoryFiles(id))
      } catch {
        // The next mutation regenerates it.
      }
    }
    return { skipped: 'error', before, after: before, budget, reason: messageOf(error) }
  } finally {
    compacting.delete(id)
  }
}

/** Human/agent-facing sentence for a compaction result, or '' when nothing happened. */
function compactionNote(result) {
  if (!result) return ''
  if (!result.skipped) {
    const still = result.after > result.budget
      ? ` It is still over the ${result.budget}-character budget: the remaining files are each too large to archive.`
      : ''
    return ` Auto-compacted the shared memory: ${result.before} → ${result.after} characters (${result.archived} file(s) moved to memory/archive/).${still}`
  }
  if (result.skipped === 'in_flight') {
    return ' A compaction is already running for this project; it will finish on its own.'
  }
  if (result.skipped === 'under_budget') return ''
  if (result.skipped === 'nothing_to_archive') {
    return ` The memory is ${result.before} characters, over its ${result.budget}-character budget, but there is nothing safe to archive: a single file is never split.`
  }
  return ` Auto-compaction failed (${result.reason}); the memory is unchanged at ${result.before} characters.`
}

/**
 * The one hook every memory write goes through: warn, then compact if the memory
 * is over budget and the project allows it. Never throws — a write that already
 * landed must not be reported as failed because housekeeping could not run.
 */
async function afterMemoryWrite(project, written) {
  const budget = memoryBudgetOf(project)
  const warning = memoryWarning(
    { length: written.total, truncated: written.truncated, name: written.file.name },
    budget,
  )
  if (written.total <= budget) return warning
  if (project.autoCompact === false) {
    return `${warning} Auto-compaction is off for this project, so the memory stays over budget.`
  }
  try {
    return `${warning}${compactionNote(await compactMemory(project.id))}`
  } catch (error) {
    return `${warning} Auto-compaction failed (${messageOf(error)}); the memory is unchanged.`
  }
}

/** The page's view of the memory: file metadata, never bodies. */
function memoryPayload(project, files) {
  return {
    files: files.map((file) => ({
      name: file.name,
      description: file.description,
      type: file.type,
      modified: file.modified,
      size: file.chars,
      stale: file.stale === true,
    })),
    total: memoryTotal(files),
    budget: memoryBudgetOf(project),
  }
}

/** The tool's index: the live index plus the bounded archive summary. */
async function memoryIndexForTool(project) {
  const files = await readMemoryFiles(project.id)
  const live = memoryIndex(files, MEMORY_INDEX_TOOL_LIMIT, { listStale: true })
  const archived = archiveSummary(await listArchiveFiles(project.id))
  return archived ? `${live}\n\n${archived}` : live
}

/** The file a tool call names: `name`, or the deprecated `section` alias. */
function memoryNameArg(args) {
  const name = typeof args?.name === 'string' ? args.name.trim() : ''
  if (name) return name
  return typeof args?.section === 'string' ? args.section.trim() : ''
}

/**
 * The board tally the page and the tools both read.
 *
 * One dimension, one bucket per task: `resolved` is a status now, so a task the
 * human accepted is counted as resolved and in no other bucket. That is exactly
 * how the page groups tasks, which is why the sidebar and the Threads panel can
 * no longer disagree ("36 waiting for review, 1 blocked" for a board the panel
 * showed as "Resolved · 37" was the bug this replaced).
 */
function counts(tasks) {
  const result = { queued: 0, running: 0, review: 0, failed: 0, blocked: 0, resolved: 0 }
  for (const task of tasks) result[task.status] = (result[task.status] || 0) + 1
  return result
}

/** "3 running, 2 review, 37 resolved", or "none". One formatter, so the tool output cannot drift. */
function formatCounts(tally) {
  const parts = STATUSES.filter((key) => tally[key] > 0).map((key) => `${tally[key]} ${key}`)
  return parts.join(', ') || 'none'
}

function summarize(project) {
  return {
    id: project.id,
    name: project.name,
    workspace: project.workspace,
    autonomy: project.autonomy,
    concurrency: project.concurrency,
    archived: project.archived,
    worktreeIsolation: project.worktreeIsolation === true,
    autoCompact: project.autoCompact !== false,
    memoryBudget: memoryBudgetOf(project),
    ...(project.lastCompaction ? { lastCompaction: project.lastCompaction } : {}),
    updatedAt: project.updatedAt,
    counts: counts(project.tasks),
  }
}

// ---------------------------------------------------------------------------
// Operations shared by the page and the tools

async function createProject(input) {
  const project = normalizeProject({
    id: newId('p'),
    name: input?.name,
    goal: input?.goal,
    workspace: input?.workspace,
    autonomy: input?.autonomy,
    concurrency: input?.concurrency,
    model: input?.model,
    agentPreset: input?.agentPreset,
    reasoningEffort: input?.reasoningEffort,
    autoCompact: input?.autoCompact,
    memoryBudget: input?.memoryBudget,
    worktreeIsolation: input?.worktreeIsolation,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tasks: [],
  })
  await writeProject(project)
  return project
}

async function updateProject(id, patch) {
  const project = await readProject(id)
  if (patch?.name !== undefined) project.name = text(patch.name, 120) || project.name
  if (patch?.goal !== undefined) project.goal = text(patch.goal, MAX_GOAL)
  if (patch?.workspace !== undefined) project.workspace = text(patch.workspace, 1024)
  if (patch?.autonomy !== undefined && AUTONOMY.includes(patch.autonomy)) project.autonomy = patch.autonomy
  if (patch?.concurrency !== undefined) project.concurrency = intIn(patch.concurrency, 1, MAX_CONCURRENCY, project.concurrency)
  if (patch?.archived !== undefined) project.archived = patch.archived === true
  // Per-task worktree isolation is a project setting. Only a real boolean flips
  // it: a string "false" must not silently turn isolation on.
  if (typeof patch?.worktreeIsolation === 'boolean') project.worktreeIsolation = patch.worktreeIsolation
  // The page may retune the project's default route: this is a project setting,
  // not a task status, so it does not touch the read-only status contract.
  if (patch?.model !== undefined) project.model = modelValue(patch.model)
  if (patch?.agentPreset !== undefined) project.agentPreset = presetValue(patch.agentPreset)
  if (patch?.reasoningEffort !== undefined) project.reasoningEffort = effortValue(patch.reasoningEffort)
  // Memory compaction settings are project settings, not task state, so the page
  // and the coordinator tool may both retune them. Only a real boolean flips
  // `autoCompact`; a string "false" must not silently turn it off.
  if (typeof patch?.autoCompact === 'boolean') project.autoCompact = patch.autoCompact
  if (patch?.memoryBudget !== undefined) {
    project.memoryBudget = intIn(patch.memoryBudget, MEMORY_BUDGET_MIN, MEMORY_BUDGET_MAX, project.memoryBudget)
  }
  if (patch?.coordinatorSessionId !== undefined) {
    const value = text(patch.coordinatorSessionId, 128)
    if (value) project.coordinatorSessionId = value
    else delete project.coordinatorSessionId
  }
  // Archiving hides the board, so every retained checkout goes with it. Cleanup
  // failures are collected rather than thrown: the archive must still succeed,
  // and a task whose cleanup failed keeps its fields so a later archive retries.
  const worktrees = patch?.archived === true ? await removeProjectWorktrees(project) : undefined
  project.updatedAt = Date.now()
  await writeProject(project)
  return { project, ...(worktrees === undefined ? {} : { worktrees }) }
}

async function addTask(id, input) {
  const project = await readProject(id)
  if (project.tasks.length >= MAX_TASKS) throw httpError(409, 'too_many_tasks')
  const task = normalizeTask({
    id: newId('t'),
    title: input?.title,
    brief: input?.brief,
    status: 'queued',
    approved: input?.approved === true,
    model: input?.model,
    agentPreset: input?.agentPreset,
    reasoningEffort: input?.reasoningEffort,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  project.tasks.push(task)
  project.updatedAt = Date.now()
  await writeProject(project)
  return { project, task }
}

/**
 * Internal writer shared by the coordinator tool and the host itself. It can
 * write every field — but the browser never reaches it directly: the page goes
 * through `resolveTask` below, which narrows the patch to the two statuses a
 * human may set before calling in here.
 */
async function updateTask(projectId, taskId, patch) {
  const project = await readProject(projectId)
  const task = project.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw httpError(404, 'task_not_found')
  if (patch?.title !== undefined) task.title = text(patch.title, 200) || task.title
  if (patch?.brief !== undefined) task.brief = text(patch.brief, MAX_BRIEF)
  if (patch?.status !== undefined && STATUSES.includes(patch.status)) task.status = patch.status
  if (patch?.approved !== undefined) task.approved = patch.approved === true
  if (patch?.output !== undefined) task.output = text(patch.output, MAX_OUTPUT)
  if (patch?.model !== undefined) task.model = modelValue(patch.model)
  if (patch?.agentPreset !== undefined) task.agentPreset = presetValue(patch.agentPreset)
  if (patch?.reasoningEffort !== undefined) task.reasoningEffort = effortValue(patch.reasoningEffort)
  task.updatedAt = Date.now()
  project.updatedAt = Date.now()
  await writeProject(project)
  return { project, task }
}

/**
 * The human write face: the page may set `status` to `resolved` (accept the
 * work) or `review` (take that acceptance back), and to nothing else. Anything
 * else in the body is rejected with 400 instead of being ignored, so a stale
 * browser bundle that still sends `resolved: true` or `status: 'done'` fails
 * loudly rather than silently believing it changed the board.
 */
async function resolveTask(projectId, taskId, patch) {
  const body = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const foreign = Object.keys(body).filter((key) => !HUMAN_TASK_FIELDS.includes(key))
  if (foreign.length > 0) {
    throw httpError(
      400,
      `only "status" is writable from the page (rejected: ${foreign.join(', ')}); the "resolved" boolean is gone — send status "resolved" or "review"`,
    )
  }
  if (body.status === undefined) throw httpError(400, 'status_required')
  if (!HUMAN_STATUSES.includes(body.status)) {
    throw httpError(
      400,
      `the page may only set status to "resolved" or "review" (rejected: ${JSON.stringify(body.status)})`,
    )
  }
  return updateTask(projectId, taskId, { status: body.status })
}

/**
 * The manual-mode gate, and its own narrow write face. `approved` is not a
 * status — it is the switch that lets a `manual` project dispatch at all — so it
 * gets a dedicated route instead of widening the PATCH whitelist. This endpoint
 * writes exactly one field, and the only value it can write is `true`; the
 * request body is ignored on purpose, so a stale bundle cannot smuggle `status`
 * through this door either.
 */
async function approveTask(projectId, taskId) {
  const project = await readProject(projectId)
  const task = project.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw httpError(404, 'task_not_found')
  // Approving an already-approved task is a no-op, not an error: the caller is
  // asking for a state the task is already in.
  if (task.approved) return { project, task }
  // A running worker already passed the gate; flipping the flag now would only
  // rewrite the audit trail. Reject instead of pretending something changed.
  if (task.status === 'running') throw httpError(400, 'task_already_running')
  return updateTask(projectId, taskId, { approved: true })
}

/**
 * Archive the session that belongs to one task, or explain why it cannot be.
 *
 * The session id is never taken from the request: it is exactly the task's own
 * `childSessionId`, the id `dispatchTask` recorded when it started the worker.
 * That is the whole safety model — there is no way to name somebody else's
 * session through this route — plus one explicit refusal for the coordinator,
 * whose conversation must never be hidden by a board operation.
 *
 * `archiveSession` (not deletion) is the supported primitive: it writes the
 * registry-global archive set, which the `ArchivedSessionGate` reads to refuse
 * model steps, and the sidebar filters archived rows out of the default view.
 * It refuses a session that still has running work (unless `stopActivity`), and
 * that refusal is propagated rather than overridden: deleting a task must not
 * silently kill a worker that is still writing.
 *
 * @returns `null` when the task never started a worker, otherwise
 *   `{ id, archived }` — `archived: false` only when the session is already gone.
 */
async function archiveTaskSession(ctx, project, task) {
  const sessionId = typeof task.childSessionId === 'string' ? task.childSessionId.trim() : ''
  if (!sessionId) return null
  if (project.coordinatorSessionId === sessionId) {
    throw httpError(
      409,
      `refusing to archive ${sessionId}: it is the coordinator session of project ${project.id}`,
    )
  }
  const registry = ctx.get('workspaceRegistry')
  if (!registry || typeof registry.archiveSession !== 'function') {
    throw httpError(503, 'workspace_registry_unavailable')
  }
  try {
    await registry.archiveSession(sessionId)
  } catch (error) {
    // A session that is already gone needs no archive: the task row is the only
    // pointer to it, so dropping the row is the whole cleanup.
    if (error?.name === 'WorkspaceUnknownSessionError') return { id: sessionId, archived: false }
    if (error?.name === 'WorkspaceActiveSessionError') {
      throw httpError(
        409,
        `refusing to archive ${sessionId}: the worker is still running (${messageOf(error)}); stop it first, or delete the task without ?session=archive`,
      )
    }
    throw httpError(500, `could not archive session ${sessionId}: ${messageOf(error)}`)
  }
  return { id: sessionId, archived: true }
}

// ---------------------------------------------------------------------------
// Per-task git worktree isolation
//
// Opt-in through `project.worktreeIsolation`. Dispatch creates
// `<workspace>/.worktrees/<taskId>` on branch `task/<taskId>` and points the
// worker's cwd at it; the checkout is retained after the worker settles so the
// human can review and merge it. Git is invoked directly (no shell) rather than
// through the host's worktree service, because this plugin must keep working in
// a profile that does not compose that service. Every operation is written so a
// failure leaves the board as it was: preflight checks run before anything is
// created, a failed creation cleans up its own artifacts, and a failed removal
// keeps the task row that points at the checkout.

const execFileAsync = promisify(execFile)

/** The child environment for git: no inherited repository selectors, no prompts. */
function gitEnv() {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_NO_LAZY_FETCH: '1',
  }
  for (const key of GIT_UNSET_KEYS) delete env[key]
  return env
}

/**
 * Run one git command without a shell.
 *
 * `allowFailure` is for commands whose non-zero exit is an answer ("does this
 * branch exist?", "is this path ignored?") rather than an error. Even then the
 * result distinguishes an exit code from a failure to start git at all: a
 * missing executable has `code: null`, so callers never mistake "git is not
 * installed" for "the answer is no".
 */
async function runGit(cwd, args, { allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      env: gitEnv(),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    })
    return { ok: true, code: 0, stdout: String(stdout).trim(), stderr: String(stderr).trim() }
  } catch (error) {
    const result = {
      ok: false,
      code: typeof error?.code === 'number' ? error.code : null,
      stdout: typeof error?.stdout === 'string' ? error.stdout.trim() : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr.trim() : '',
      error,
    }
    if (allowFailure) return result
    throw new Error(
      `git ${args.join(' ')} failed${result.code === null ? '' : ` (exit ${result.code})`}: ${result.stderr || result.stdout || messageOf(error)}`,
    )
  }
}

/**
 * The repository root above `directory`, or null when it is not inside a git
 * working tree. A missing git executable and a repository git refuses to read
 * (dubious ownership, a bare repository) are errors, not "not a repository":
 * silently degrading there would hide a broken environment.
 */
async function gitRepositoryRoot(directory) {
  const result = await runGit(directory, ['rev-parse', '--show-toplevel'], { allowFailure: true })
  if (result.ok) return result.stdout
  if (result.code === 128 && /not a git repository/i.test(result.stderr)) return null
  throw new Error(
    `Could not read the git repository at ${directory}: ${result.stderr || result.stdout || (result.code === null ? 'git is not available' : `exit ${result.code}`)}`,
  )
}

/**
 * The main checkout of the repository that contains `directory`.
 *
 * `git worktree remove` and `git branch` act on the common repository, and from
 * a linked worktree `rev-parse --show-toplevel` names that worktree, not the
 * main checkout. The first entry of `worktree list --porcelain` is always the
 * main one, so it is the stable place to run both commands from.
 */
async function gitMainRepositoryRoot(directory) {
  const result = await runGit(directory, ['worktree', 'list', '--porcelain'], { allowFailure: true })
  if (!result.ok) return null
  const first = result.stdout.split('\n').find((line) => line.startsWith('worktree '))
  return first ? first.slice('worktree '.length) : null
}

/** Whether the repository ignores `relativePath` (the `.worktrees/` pool, say). */
async function gitIgnores(directory, relativePath) {
  const result = await runGit(directory, ['check-ignore', '--no-index', '-q', '--', relativePath], { allowFailure: true })
  if (result.ok) return true
  if (result.code === 1) return false
  throw new Error(
    `Could not check whether ${relativePath} is ignored in ${directory}: ${result.stderr || result.stdout || (result.code === null ? 'git is not available' : `exit ${result.code}`)}`,
  )
}

/**
 * The branch and checkout path one task would use, validated before any git
 * command that writes. The task id is one path segment and one branch suffix,
 * so a malformed id is rejected here rather than being allowed to escape the
 * pool or be parsed as a git option.
 */
function worktreePlan(project, task) {
  const id = typeof task.id === 'string' ? task.id : ''
  if (!WORKTREE_ID.test(id)) {
    throw new Error(
      `Task id ${JSON.stringify(id)} cannot be used as a worktree name: use letters, digits, ".", "_" or "-" (not a leading "-").`,
    )
  }
  const workspace = project.workspace
  if (!workspace) throw new Error('The project has no workspace, so there is nowhere to create a worktree.')
  const root = resolve(workspace, WORKTREE_DIR)
  const path = resolve(root, id)
  if (dirname(path) !== root || basename(path) !== id) {
    throw new Error(`Task id ${JSON.stringify(id)} would escape ${root}.`)
  }
  return { id, workspace, root, path, branch: `${WORKTREE_BRANCH_PREFIX}${id}` }
}

/** A path is exactly this task's pool entry, so cleanup may remove it. */
function isManagedWorktreePath(project, task, path) {
  if (!project.workspace || !path) return false
  return resolve(path) === resolve(project.workspace, WORKTREE_DIR, String(task.id))
}

/**
 * Best-effort removal of the artifacts a failed creation may have left. It never
 * throws: the caller is already reporting the original failure, and a cleanup
 * problem must not replace it. The checkout path is the exact pool entry
 * validated by `worktreePlan`, so removing it cannot touch anything else.
 */
async function cleanupFailedWorktree(repoRoot, plan, branchExistedBefore) {
  try {
    await runGit(repoRoot, ['worktree', 'remove', '--force', '--', plan.path], { allowFailure: true })
    await runGit(repoRoot, ['worktree', 'prune'], { allowFailure: true })
    if (!branchExistedBefore) {
      const branch = await runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${plan.branch}`], { allowFailure: true })
      if (branch.ok) await runGit(repoRoot, ['branch', '-D', '--', plan.branch], { allowFailure: true })
    }
    if (await pathExists(plan.path)) await rm(plan.path, { recursive: true, force: true })
  } catch {
    // Keep the original error; the task stays queued and a retry can reuse the
    // branch or report the leftover path.
  }
}

/**
 * Create (or reuse) the worktree for one task.
 *
 * @returns `{ path, branch, repoRoot, reused }` on success, or
 *   `{ degraded, note }` when the workspace cannot provide isolation (missing
 *   directory, not a git repository). A condition that would pollute the
 *   repository or leave a half-created checkout throws instead: the caller then
 *   leaves the task queued and reports the error, which is the recoverable
 *   failure the feature promises.
 */
async function createTaskWorktree(project, task) {
  const workspace = typeof project.workspace === 'string' ? project.workspace : ''
  if (!workspace) {
    return {
      degraded: 'workspace_missing',
      note: 'Worktree isolation is on, but the project has no workspace; the worker ran in the coordinator\'s directory.',
    }
  }
  if (!(await isDirectory(workspace))) {
    return {
      degraded: 'workspace_missing',
      note: `Worktree isolation is on, but the project workspace ${workspace} is not a directory; the worker ran in the shared workspace.`,
    }
  }
  const plan = worktreePlan(project, task)
  const repoRoot = await gitRepositoryRoot(plan.workspace)
  if (!repoRoot) {
    return {
      degraded: 'not_a_git_repository',
      note: `Worktree isolation is on, but ${plan.workspace} is not inside a git repository; the worker ran in the shared workspace.`,
    }
  }
  // Git's own ref grammar is the final word: a hand-written task id can pass the
  // slug pattern and still be an invalid branch (a trailing ".lock", say).
  const ref = await runGit(repoRoot, ['check-ref-format', `refs/heads/${plan.branch}`], { allowFailure: true })
  if (!ref.ok) throw new Error(`"${plan.branch}" is not a valid git branch name for task ${task.id}.`)
  // Refuse before creating anything: an unignored pool would show up as an
  // untracked directory in the repository this feature must not pollute.
  if (!(await gitIgnores(plan.workspace, `${WORKTREE_DIR}/`))) {
    throw new Error(
      `Worktree isolation is on, but "${WORKTREE_DIR}/" is not ignored in ${plan.workspace}. `
      + `Add "${WORKTREE_DIR}/" to the repository's .gitignore (or turn project.worktreeIsolation off) and dispatch again.`,
    )
  }
  const pathExistsNow = await pathExists(plan.path)
  const branchExists = (await runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${plan.branch}`], { allowFailure: true })).ok
  if (pathExistsNow) {
    // A retry after a failed start may find the checkout it created last time.
    // Reuse it only when it really is this task's branch; anything else is a
    // collision a human must resolve, not something to overwrite.
    const head = await runGit(plan.path, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true })
    if (!head.ok || head.stdout !== plan.branch) {
      throw new Error(
        `Worktree path ${plan.path} already exists and is not a checkout of ${plan.branch}. Remove it (or the branch) before dispatching task ${task.id}.`,
      )
    }
    return { path: plan.path, branch: plan.branch, repoRoot, reused: true }
  }
  try {
    if (branchExists) {
      // The branch survived an earlier failure; check it out instead of creating
      // it again, so a retry does not need manual cleanup.
      await runGit(repoRoot, [
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
        'worktree', 'add', '--', plan.path, plan.branch,
      ])
    } else {
      await runGit(repoRoot, [
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
        'worktree', 'add', '-b', plan.branch, '--', plan.path, 'HEAD',
      ])
    }
    const head = await runGit(plan.path, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true })
    if (!head.ok || head.stdout !== plan.branch) {
      throw new Error(`the new checkout is not on ${plan.branch} (git reported ${head.stdout || head.stderr || 'no branch'})`)
    }
  } catch (error) {
    await cleanupFailedWorktree(repoRoot, plan, branchExists)
    throw new Error(`Could not create the git worktree for task ${task.id} at ${plan.path}: ${messageOf(error)}`)
  }
  return { path: plan.path, branch: plan.branch, repoRoot, reused: false }
}

/**
 * Remove the worktree and branch recorded on one task.
 *
 * Idempotent: a missing directory or branch is success, so a retry after a
 * partial failure finishes the job. `--force` is deliberate — deleting a task is
 * the human asking for the checkout to go, including uncommitted work; the
 * alternative would be a board row that can never be deleted because its
 * worktree is dirty.
 *
 * @returns `null` when the task never had a worktree, otherwise
 *   `{ removed, branchDeleted, note? }`.
 */
async function removeTaskWorktree(project, task) {
  const path = typeof task.worktreePath === 'string' ? task.worktreePath : ''
  const branch = typeof task.branch === 'string' ? task.branch : ''
  if (!path && !branch) return null
  const start = path && (await isDirectory(path)) ? path : project.workspace
  const repoRoot = start && (await isDirectory(start)) ? await gitMainRepositoryRoot(start) : null
  if (!repoRoot) {
    if (path && (await pathExists(path))) {
      throw new Error(`Could not find the git repository for worktree ${path}; remove it manually before deleting the task.`)
    }
    return { removed: false, branchDeleted: false, note: 'worktree and repository are already gone' }
  }
  let removed = false
  if (path && (await pathExists(path))) {
    const result = await runGit(repoRoot, ['worktree', 'remove', '--force', '--', path], { allowFailure: true })
    if (!result.ok) {
      // Not registered but present: a leftover from a failed creation. Only the
      // exact pool entry is removed; anything else is reported, never deleted.
      if (!isManagedWorktreePath(project, task, path)) {
        throw new Error(`Could not remove worktree ${path}: ${result.stderr || result.stdout || `exit ${result.code}`}`)
      }
      await rm(path, { recursive: true, force: true })
    }
    removed = true
  }
  await runGit(repoRoot, ['worktree', 'prune'], { allowFailure: true })
  let branchDeleted = false
  if (branch) {
    const exists = await runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true })
    if (exists.ok) {
      const deleted = await runGit(repoRoot, ['branch', '-D', '--', branch], { allowFailure: true })
      if (!deleted.ok) {
        throw new Error(`Could not delete branch ${branch}: ${deleted.stderr || deleted.stdout || `exit ${deleted.code}`}`)
      }
      branchDeleted = true
    }
  }
  return { removed, branchDeleted }
}

/**
 * Remove every worktree recorded on a project's tasks. Used when a project is
 * archived: the board is hidden, so leaving checkouts behind would strand them.
 * Failures are collected, not thrown: archiving must still succeed, and a task
 * whose cleanup failed keeps its fields so a later archive retries it.
 */
async function removeProjectWorktrees(project) {
  const removed = []
  const failed = []
  for (const task of project.tasks) {
    if (!task.worktreePath && !task.branch) continue
    try {
      const result = await removeTaskWorktree(project, task)
      removed.push({ taskId: task.id, ...(result || {}) })
      delete task.worktreePath
      delete task.branch
      delete task.worktreeDegraded
      delete task.worktreeNote
    } catch (error) {
      failed.push({ taskId: task.id, error: messageOf(error) })
      task.worktreeNote = `Worktree cleanup failed while archiving: ${messageOf(error)}`
    }
  }
  return { removed, failed }
}

/**
 * Remove one task from the board, optionally archiving its worker session, and
 * remove the git worktree/branch it recorded.
 *
 * Order: the worktree is removed first, then the session is archived, then the
 * task is spliced out and written. The task row holds the only references to
 * both `childSessionId` and `worktreePath`, so the write must come last. The
 * worktree goes first because a git failure is the more likely one and leaves
 * both the task and the session untouched; if the later archive fails instead,
 * the task stays on the board and a retry is safe because removing an already
 * gone worktree is a no-op. A failed project write leaves an archived session
 * whose task is still on the board — the page's `/sessions/restore` route
 * unarchives it, and retrying the delete is safe because archiving an
 * already-archived id is a no-op.
 */
async function removeTask(ctx, projectId, taskId, action = '') {
  const project = await readProject(projectId)
  const index = project.tasks.findIndex((candidate) => candidate.id === taskId)
  if (index < 0) throw httpError(404, 'task_not_found')
  const task = project.tasks[index]
  const worktree = await removeTaskWorktree(project, task)
  const session = action === 'archive' ? await archiveTaskSession(ctx, project, task) : null
  project.tasks.splice(index, 1)
  project.updatedAt = Date.now()
  await writeProject(project)
  return { project, session, worktree }
}

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Characters that identify the language the human actually writes in.
 *
 * Han is checked before Latin on purpose: a Chinese brief is full of Latin
 * identifiers (`workerPrompt`, `host/index.js`), so counting the two scripts and
 * taking the majority would misread most Chinese tasks as English. Latin alone
 * is a reliable English signal because English text never contains Han.
 * Kana is checked first and suppresses the directive entirely: Japanese uses
 * Han too, so guessing `zh` there would be worse than saying nothing.
 */
const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/u
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
const LATIN = /[A-Za-z]/u

/**
 * The language a worker should answer in, derived from the human's own words.
 *
 * The Host has no locale service to consult: `locale` is provided by the
 * *Client* half of `dsh-client-locale` (`src/client/index.ts`, `ctx.provide`),
 * and its Host half only declares a settings namespace. The preference is
 * technically reachable through `ctx.get('settings').describe()`, but it is the
 * wrong signal even then: it is a *UI* language, this profile pins it to `en`,
 * and the human still writes Chinese briefs — following it would reproduce the
 * bug this fixes. What the human wants to read is described by what the human
 * wrote, so the brief wins and the project instructions are the fallback.
 *
 * @returns `'zh'`, `'en'`, or `''` when no directive is safe to state.
 */
function replyLanguage(project, task) {
  const sample = task.brief.trim() || project.goal.trim()
  if (!sample) return ''
  if (KANA.test(sample)) return ''
  if (HAN.test(sample)) return 'zh'
  if (LATIN.test(sample)) return 'en'
  return ''
}

/**
 * The hard language rule injected into every worker prompt.
 *
 * Workers used to answer in English whenever the brief was Chinese, because the
 * whole prompt is English and the model took that as the conversation language;
 * the English output then showed up as the thread subtitle and the embedded
 * conversation. The rule is stated as a rule, not a preference, and it names the
 * things that must not override it (this prompt, tool names, code, the memory).
 */
function languageRule(language) {
  const lines = ['## Language (hard rule)']
  if (language === 'zh') {
    lines.push('Write your entire reply in Chinese (中文) — the language the human wrote the task brief in.')
  } else if (language === 'en') {
    lines.push('Write your entire reply in English — the language the human wrote the task brief in.')
  } else {
    lines.push('Write your entire reply in the language the human wrote the task brief in: a Chinese brief means a Chinese reply, an English brief means an English reply.')
  }
  lines.push(
    'If the brief is empty or in another language, follow the language of the project instructions instead; if the two disagree, follow the brief.',
    'This prompt being in English is not a reason to answer in English, and neither are tool names, code, file paths or the shared project memory.',
  )
  return lines
}

function workerPrompt(project, task, memoryFiles, workdir, branch) {
  const lines = [
    `You are the worker for one task in the DSH project "${project.name}" (project_id: ${project.id}).`,
    'Do only this task, then report back. The coordinator keeps working while you run.',
    '',
    // Near the top on purpose: the model settles its answer language from the
    // first screen of the prompt, and the rest of this prompt is English.
    ...languageRule(replyLanguage(project, task)),
    '',
    '## Project instructions',
    project.goal.trim() || '(none)',
    '',
    '## Shared project memory',
    // An index, not the text. The memory is one file per topic; injecting every
    // file made each worker pay for history it does not need. The worker can pull
    // the one file it needs with projects_memory.
    memoryIndex(memoryFiles),
    '',
    `The list above is an index of the shared memory, not its contents. Read a file before relying on it: projects_memory {project_id:"${project.id}", action:"read", name:"<name>"}.`,
    '',
    '## Your task',
    `Title: ${task.title}`,
  ]
  if (task.brief.trim()) lines.push('', task.brief.trim())
  lines.push(
    '',
    '## How to work',
    // The effective working directory, not always the project workspace: with
    // worktree isolation the worker's cwd is its own checkout.
    workdir ? `- Work inside ${workdir}.` : '- Work in the current directory.',
    ...(branch
      ? [`- This is an isolated git worktree on branch ${branch}; commit your changes there. The coordinator will not merge it automatically.`]
      : []),
    '- Keep changes scoped to this task; do not rewrite unrelated code.',
    `- Before finishing, append what later tasks must know (findings, decisions, gotchas) to the shared memory with the projects_memory tool: project_id "${project.id}", action "append", name "<topic-slug>", description "<one line>".`,
    '- Do not change the task status; the runner records your final message as the task output.',
    '- If the task cannot be completed, say what blocked it and what a human must decide.',
    '- Finish with a short report: what you changed, where, and how you verified it.',
  )
  return lines.join('\n')
}

/**
 * Whether a worker is still running behind a task.
 *
 * Status alone cannot answer this once `resolved` is a status: the human may
 * accept a task while its worker is still going, which flips the status to
 * `resolved` and would otherwise hide a live worker from the dispatch guard and
 * the concurrency ceiling. `finishedAt` is the run's real end marker (dispatch
 * clears it, settle writes it), so liveness is "has a session and has not
 * settled yet". The status check keeps a legacy row that predates `finishedAt`
 * from being treated as live forever.
 */
function workerIsLive(task) {
  if (!task.childSessionId || task.finishedAt) return false
  return task.status === 'running' || task.status === 'resolved'
}

async function dispatchTask(ctx, exec, projectId, taskId) {
  const subagents = ctx.get('subagents')
  if (!subagents) throw new Error('The subagent service is unavailable in this profile, so no worker can start.')
  if (!exec?.agent) throw new Error('projects_dispatch needs a calling agent (exec.agent was undefined).')
  const project = await readProject(projectId)
  if (project.archived) return `Project ${project.id} is archived. Unarchive it before dispatching.`
  const task = project.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new Error(`Unknown task ${taskId} in project ${project.id}.`)
  if (workerIsLive(task)) {
    return `Task ${task.id} is already running as ${task.childName || task.childSessionId || 'a worker'}.`
  }
  // Dispatching a resolved task would silently erase the human's verdict (the
  // dispatch writes status running). Send it back to review first, which is the
  // same two-step the page uses to un-accept a task.
  if (task.status === 'resolved') {
    return `Task ${task.id} is resolved. Send it back to review (projects_update_task status "review") before dispatching it again.`
  }
  if (project.autonomy === 'manual' && !task.approved) {
    return `Task ${task.id} needs human approval first: project autonomy is "manual". Ask the user to approve it on the Projects page, then call projects_dispatch again.`
  }
  const running = project.tasks.filter(workerIsLive).length
  if (running >= project.concurrency) {
    return `Concurrency limit reached (${running}/${project.concurrency} workers running). Wait for one to settle before dispatching ${task.id}.`
  }
  const memoryFiles = await readMemoryFiles(project.id)
  const controller = new AbortController()
  let cwd = project.workspace && (await isDirectory(project.workspace)) ? project.workspace : undefined
  // Per-task isolation is opt-in. A task that already recorded a checkout keeps
  // its `branch`/`worktreePath` when the switch is later turned off: those
  // fields describe the retained checkout, not the current run, and deleting
  // them here would orphan it. Only the degradation note belongs to the latest
  // dispatch, so it is cleared when isolation was not requested.
  let worktree = null
  let isolationNote = ''
  if (project.worktreeIsolation) {
    const prepared = await createTaskWorktree(project, task)
    if (prepared.degraded) {
      // The historical behavior: run in the shared workspace, but say why on
      // the task so the coordinator (and the page) can see isolation was asked
      // for and not delivered.
      task.worktreeDegraded = prepared.degraded
      task.worktreeNote = prepared.note
      isolationNote = ` Worktree isolation degraded (${prepared.degraded}): ${prepared.note}`
    } else {
      worktree = prepared
      cwd = prepared.path
      task.branch = prepared.branch
      task.worktreePath = prepared.path
      delete task.worktreeDegraded
      delete task.worktreeNote
      isolationNote = ` worktree=${prepared.path} branch=${prepared.branch}${prepared.reused ? ' (reused)' : ''}.`
    }
  } else {
    delete task.worktreeDegraded
    delete task.worktreeNote
  }
  // Route precedence: the task override wins over the project default, and an
  // empty result means "let the child inherit the parent Agent's route" — in
  // which case `agentOptions` is omitted entirely rather than sent as `{}` or
  // with an undefined model, both of which the service would reject or misread.
  const route = modelRoute(task.model || project.model)
  const agentPreset = presetValue(task.agentPreset || project.agentPreset)
  // Effort precedence mirrors the model: the task override wins, then the project
  // default, and an empty result means "let the provider apply its own default".
  //
  // The route-change rule in the subagent service only *drops an inherited*
  // effort when the provider/model differs from the parent and the caller gave
  // none. We always set the effort explicitly when one is configured, so that
  // rule can never silently discard the user's choice; when none is configured
  // we send no effort at all and the provider default applies, which is exactly
  // what "unset" means. Never send '' — an empty id is not a valid effort.
  const effort = effortValue(task.reasoningEffort || project.reasoningEffort)
  const agentOptions = route === undefined && !effort
    ? undefined
    : {
      ...(route === undefined ? {} : route),
      ...(effort ? { reasoningEffort: effort } : {}),
    }
  let started
  try {
    started = await subagents.startActivation({
      provider: 'spawn',
      label: `${project.name} · ${task.title}`.slice(0, 120),
      prompt: [{ type: 'text', text: workerPrompt(project, task, memoryFiles, cwd, worktree?.branch) }],
      parent: exec.agent,
      ...(cwd === undefined ? {} : { cwd }),
      ...(agentPreset ? { agentPreset } : {}),
      ...(agentOptions === undefined ? {} : { agentOptions }),
      signal: controller.signal,
      delivery: 'parent',
    })
  } catch (error) {
    // A worker that never started must not leave a checkout behind: the task is
    // still queued, and the next dispatch would collide with the orphan.
    if (worktree && !worktree.reused) {
      try {
        await removeTaskWorktree(project, { id: task.id, worktreePath: worktree.path, branch: worktree.branch })
        delete task.branch
        delete task.worktreePath
      } catch (cleanupError) {
        throw new Error(
          `Could not start the worker: ${messageOf(error)} `
          + `(the new worktree ${worktree.path} could not be removed: ${messageOf(cleanupError)})`,
        )
      }
    }
    throw new Error(`Could not start the worker: ${messageOf(error)}`)
  }
  controllers.set(task.id, controller)
  task.status = 'running'
  task.childSessionId = String(started.childId)
  task.childName = started.name
  task.startedAt = Date.now()
  delete task.finishedAt
  delete task.stopReason
  task.output = ''
  task.updatedAt = Date.now()
  project.updatedAt = Date.now()
  await writeProject(project)
  const routeNote = route === undefined ? '' : ` model=${route.provider ? `${route.provider}/` : ''}${route.model}`
  const presetNote = agentPreset ? ` preset=${agentPreset}` : ''
  const effortNote = effort ? ` effort=${effort}` : ''
  return `Dispatched task ${task.id} to worker ${started.name} (session ${started.childId})${routeNote}${effortNote}${presetNote}.${isolationNote} It runs in the background; its final message lands on the task when it settles.`
}

async function settleWorker(info) {
  if (!info || typeof info.id !== 'string') return
  const projects = await listProjects()
  for (const project of projects) {
    const task = project.tasks.find((candidate) => candidate.childSessionId === info.id)
    if (!task) continue
    // `finishedAt` is the run's end marker, not the status: the human may have
    // accepted the task while its worker was still running, and that verdict must
    // not swallow the worker's final message. Only a run that already settled is
    // ignored (a duplicate event), and only a still-running task has its status
    // overwritten — a resolved task keeps the human's answer.
    if (task.finishedAt) return
    if (task.status === 'running') task.status = info.stopReason === 'completed' ? 'review' : 'failed'
    task.stopReason = typeof info.stopReason === 'string' ? info.stopReason : undefined
    task.output = blocksToText(info.lastAssistantMessage).slice(0, MAX_OUTPUT)
    task.finishedAt = Date.now()
    task.updatedAt = Date.now()
    project.updatedAt = Date.now()
    await writeProject(project)
    controllers.delete(task.id)
    return
  }
}

// ---------------------------------------------------------------------------
// Model catalog

/** Successful enumerations, keyed by the provider set they were built from. */
const modelCache = new Map()
const MODEL_CACHE_MS = 60_000

/**
 * Read the reasoning levels one exact provider/model route accepts.
 *
 * Efforts are provider-owned opaque ids, so nothing here is enumerated locally:
 * the adapter answers, and an adapter that reports no `reasoning` (or throws)
 * yields `{ efforts: [] }` — "this route exposes no choice", which is different
 * from "the effort is empty". Never let one model's failure blank the picker.
 *
 * The display field is `name`, matching the Host's own `ModelReasoningEffort`
 * shape (`{ id, name, description? }`) that the page's pickers read; the model
 * entries above keep `label` because that is their existing contract.
 */
async function reasoningOf(llm, providerId, modelId) {
  let resolved
  try {
    resolved = await llm.resolveModelInfo(providerId, modelId)
  } catch {
    return { efforts: [] }
  }
  const reasoning = resolved && typeof resolved === 'object' ? resolved.reasoning : undefined
  if (!reasoning || !Array.isArray(reasoning.efforts)) return { efforts: [] }
  const efforts = []
  for (const effort of reasoning.efforts) {
    if (!effort || typeof effort.id !== 'string' || !effort.id) continue
    efforts.push({
      id: effort.id,
      name: typeof effort.name === 'string' && effort.name ? effort.name : effort.id,
      ...(typeof effort.description === 'string' && effort.description ? { description: effort.description } : {}),
    })
  }
  const defaultEffort = typeof reasoning.defaultEffort === 'string' && reasoning.defaultEffort
    ? reasoning.defaultEffort
    : undefined
  return { efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) }
}

/**
 * Enumerate the LLM routes a worker may be pinned to, for the page's model
 * picker.
 *
 * The `llm` service is the only source of truth: `listProviders()` is sync,
 * `listModels(provider)` is async and may reach the network, so each provider is
 * isolated — one unreachable catalog must not blank the whole picker. When the
 * service is absent (a profile without an LLM adapter) or advertises nothing,
 * the answer is `enumerable: false` so the page falls back to free text instead
 * of offering an empty list.
 *
 * Each entry's `id` is the `provider/model` route string that `project.model` and
 * `task.model` store, so the picker can round-trip a choice without guessing.
 *
 * Each entry also carries `efforts`: the reasoning levels that exact route
 * accepts, as `{ id, name, description? }`, plus `defaultEffort` when the
 * adapter declares one. `listModels()` does NOT expose reasoning — only
 * `resolveModelInfo(provider, model)` returns `reasoning` — so this costs one
 * extra adapter call per model. That is the same projection the Host's own model
 * selector builds (`dsh-api-session-controller/src/catalog.ts`), and it is
 * isolated per model: a route whose metadata cannot be resolved still appears in
 * the picker with `efforts: []`, so the page can degrade that row to free text
 * instead of losing the model.
 */
async function listModelChoices(ctx) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return { models: [], enumerable: false }
  }
  let providers
  try {
    providers = llm.listProviders()
  } catch {
    return { models: [], enumerable: false }
  }
  if (!Array.isArray(providers)) return { models: [], enumerable: false }
  const ids = providers
    .map((provider) => (provider && typeof provider.id === 'string' ? provider.id : ''))
    .filter(Boolean)
  if (ids.length === 0) return { models: [], enumerable: false }

  const cacheKey = ids.join('\n')
  const cached = modelCache.get(cacheKey)
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return { models: cached.models, enumerable: true }

  const canResolve = typeof llm.resolveModelInfo === 'function'
  const models = []
  for (const providerId of ids) {
    let advertised
    try {
      advertised = await llm.listModels(providerId)
    } catch {
      continue
    }
    for (const model of Array.isArray(advertised) ? advertised : []) {
      if (!model || typeof model.id !== 'string' || !model.id) continue
      const reasoning = canResolve ? await reasoningOf(llm, providerId, model.id) : { efforts: [] }
      models.push({
        id: `${providerId}/${model.id}`,
        provider: providerId,
        model: model.id,
        label: typeof model.name === 'string' && model.name ? model.name : model.id,
        ...(typeof model.description === 'string' && model.description ? { description: model.description } : {}),
        efforts: reasoning.efforts,
        ...(reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort }),
      })
    }
  }
  if (models.length === 0) return { models: [], enumerable: false }
  modelCache.set(cacheKey, { at: Date.now(), models })
  return { models, enumerable: true }
}

/** Enumerate agent presets a worker may be pinned to; same degrade strategy. */
async function listPresetChoices(ctx) {
  const registry = ctx.get('agentPresets')
  if (!registry || typeof registry.list !== 'function') return { presets: [], enumerable: false }
  let rows
  try {
    rows = await registry.list()
  } catch {
    return { presets: [], enumerable: false }
  }
  const presets = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row.id === 'string' && row.id)
    .map((row) => ({
      id: row.id,
      label: typeof row.name === 'string' && row.name ? row.name : row.id,
      ...(typeof row.description === 'string' && row.description ? { description: row.description } : {}),
      ...(typeof row.broken === 'string' && row.broken ? { broken: row.broken } : {}),
    }))
  return { presets, enumerable: presets.length > 0 }
}

// ---------------------------------------------------------------------------
// Browser routes

function send(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(httpError(413, 'body_too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(httpError(400, 'invalid_json'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * The `?session=` value of a task DELETE, normalized. Absent, empty and
 * whitespace all mean "no session action", which is the conservative default:
 * deleting a task must never touch a session unless the caller asked.
 */
function sessionActionOf(searchParams) {
  const raw = searchParams && typeof searchParams.get === 'function' ? searchParams.get('session') : null
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

async function routeRequest(ctx, method, path, req, searchParams) {
  const parts = path.split('/').filter(Boolean)

  // /sessions/restore — an archived Session rejects every model step, so the
  // page restores the conversation it owns before talking to it.
  if (parts[0] === 'sessions') {
    if (parts.length !== 2 || parts[1] !== 'restore') throw httpError(404, 'not_found')
    if (method !== 'POST') throw httpError(405, 'method_not_allowed')
    const body = await readJson(req)
    const sessionId = text(body?.sessionId, 128)
    if (!sessionId) throw httpError(400, 'sessionId_required')
    const registry = ctx.get('workspaceRegistry')
    if (!registry || typeof registry.unarchiveSession !== 'function') {
      throw httpError(503, 'workspace_registry_unavailable')
    }
    await registry.unarchiveSession(sessionId)
    return { status: 200, body: { restored: true } }
  }

  // /models — the worker model catalog the page's picker needs. Read-only, so a
  // GET is the only method; `enumerable: false` tells the page to fall back to a
  // free-text field instead of an empty dropdown.
  if (parts.length === 1 && parts[0] === 'models') {
    if (method !== 'GET') throw httpError(405, 'method_not_allowed')
    const models = await listModelChoices(ctx)
    const presets = await listPresetChoices(ctx)
    return { status: 200, body: { ...models, presets: presets.presets, presetsEnumerable: presets.enumerable } }
  }

  if (parts[0] !== 'projects') throw httpError(404, 'not_found')

  // /projects
  if (parts.length === 1) {
    if (method === 'GET') {
      const projects = await listProjects()
      return { status: 200, body: { projects: projects.map(summarize) } }
    }
    if (method === 'POST') {
      const body = await readJson(req)
      const project = await createProject(body)
      return { status: 201, body: { project: summarize(project) } }
    }
    throw httpError(405, 'method_not_allowed')
  }

  const projectId = parts[1]

  // /projects/:id
  if (parts.length === 2) {
    if (method === 'GET') {
      const project = await readProject(projectId)
      // The page gets the file list, not the memory text: the memory is one file
      // per topic, and a single body is fetched from /projects/:id/memory/:name.
      const files = await readMemoryFiles(project.id)
      return { status: 200, body: { project, memory: memoryPayload(project, files) } }
    }
    if (method === 'PATCH') {
      const body = await readJson(req)
      const { project, worktrees } = await updateProject(projectId, body)
      // `worktrees` is present only on an archive request: it reports what the
      // cleanup removed and what it could not, without failing the archive.
      return { status: 200, body: { project, ...(worktrees === undefined ? {} : { worktrees }) } }
    }
    throw httpError(405, 'method_not_allowed')
  }

  // /projects/:id/memory — the whole memory as an index plus the file list.
  if (parts.length === 3 && parts[2] === 'memory') {
    if (method === 'GET') {
      const project = await readProject(projectId)
      const files = await readMemoryFiles(project.id)
      return {
        status: 200,
        body: { memory: memoryPayload(project, files), index: renderMemoryIndexFile(files) },
      }
    }
    if (method === 'POST') {
      // Read the body before touching the store: `readJson` attaches its
      // listeners synchronously, so the request cannot lose a chunk that
      // arrives while the project file is still being read.
      const body = await readJson(req)
      if (typeof body?.text !== 'string') throw httpError(400, 'text_required')
      const name = memoryNameOrThrow(body?.name)
      const project = await readProject(projectId)
      const written = await writeMemoryFile(project.id, {
        name,
        description: body?.description,
        type: body?.type,
        text: body.text,
      })
      // The page's memory editor is a write path like any other, so it compacts
      // too.
      const compaction = await afterMemoryWrite(project, written)
      return {
        status: 200,
        body: { saved: true, name: written.file.name, size: written.file.chars, compaction },
      }
    }
    throw httpError(405, 'method_not_allowed')
  }

  // /projects/:id/memory/:name — one file's body, for the page's preview/editor.
  if (parts.length === 4 && parts[2] === 'memory') {
    let name
    try {
      name = decodeURIComponent(parts[3])
    } catch {
      throw httpError(400, 'bad_memory_name')
    }
    if (method === 'GET') {
      const project = await readProject(projectId)
      const found = await readMemoryFile(project.id, name)
      if (!found) throw httpError(404, 'memory_file_not_found')
      return {
        status: 200,
        body: {
          name: found.file.name,
          description: found.file.description,
          type: found.file.type,
          modified: found.file.modified,
          size: found.file.chars,
          text: found.file.body,
          archived: found.archived,
        },
      }
    }
    if (method === 'DELETE') {
      const project = await readProject(projectId)
      const deleted = await deleteMemoryFile(project.id, name)
      return { status: 200, body: { deleted: true, name: deleted.file.name } }
    }
    throw httpError(405, 'method_not_allowed')
  }

  // Tasks are created only by the coordinator (`projects_add_task`): there is
  // deliberately no `POST /projects/:id/tasks` route, so the page cannot invent
  // work. A POST here falls through to the 404 below. The only POST the page may
  // make under /tasks is the narrow `.../approve` gate right after this block.

  // /projects/:id/tasks/:taskId
  if (parts.length === 4 && parts[2] === 'tasks') {
    const taskId = parts[3]
    if (method === 'PATCH') {
      const body = await readJson(req)
      const { task } = await resolveTask(projectId, taskId, body)
      return { status: 200, body: { task } }
    }
    if (method === 'DELETE') {
      const action = sessionActionOf(searchParams)
      if (action && !SESSION_ACTIONS.includes(action)) {
        throw httpError(
          400,
          SESSION_DELETE_SPELLINGS.includes(action)
            ? SESSION_DELETE_REFUSED
            : `unknown session action "${action}" (supported: ${SESSION_ACTIONS.join(', ')})`,
        )
      }
      const { session, worktree } = await removeTask(ctx, projectId, taskId, action)
      return {
        status: 200,
        // `worktree` is null when the task never had one, so a board that does
        // not use isolation keeps the exact response shape it had before.
        body: { deleted: true, session, ...(worktree === null ? {} : { worktree }) },
      }
    }
    throw httpError(405, 'method_not_allowed')
  }

  // /projects/:id/tasks/:taskId/approve — the manual-mode gate. One field, one
  // value, its own entry point: PATCH stays the accept door (status resolved or
  // review) and this stays `approved: true`-only, so neither door can be used to
  // write the other field.
  if (parts.length === 5 && parts[2] === 'tasks' && parts[4] === 'approve') {
    if (method !== 'POST') throw httpError(405, 'method_not_allowed')
    const { task } = await approveTask(projectId, parts[3])
    return { status: 200, body: { task } }
  }

  throw httpError(404, 'not_found')
}

function createRouteHandler(ctx) {
  return async (req, res) => {
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      send(res, 400, { error: 'bad_request' })
      return
    }
    const path = url.pathname.slice(ROUTE.length) || '/'
    const method = (req.method || 'GET').toUpperCase()
    try {
      const result = await routeRequest(ctx, method, path, req, url.searchParams)
      send(res, result.status, result.body)
    } catch (error) {
      const status = Number(error?.status) || 500
      send(res, status, { error: messageOf(error) })
    }
  }
}

// ---------------------------------------------------------------------------
// Agent tools

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
}

/** " · last compaction 77824 → 38000 at <iso>", or '' before the first run. */
function formatCompaction(project) {
  const last = project.lastCompaction
  if (!last || !last.at) return ''
  return ` · last compaction ${last.before} → ${last.after} characters at ${new Date(last.at).toISOString()}`
}

function formatProject(project, memoryFiles) {
  const lines = [
    `Project ${project.id} — ${project.name}`,
    `workspace: ${project.workspace || '(inherited)'}`,
    `autonomy: ${project.autonomy}, concurrency: ${project.concurrency}${project.worktreeIsolation ? ', worktree isolation: on' : ''}${project.archived ? ', ARCHIVED' : ''}`,
    `worker model: ${project.model || '(host default)'}${project.reasoningEffort ? `, effort: ${project.reasoningEffort}` : ''}${project.agentPreset ? `, preset: ${project.agentPreset}` : ''}`,
    `memory: budget ${memoryBudgetOf(project)}, auto-compaction ${project.autoCompact === false ? 'off' : 'on'}${formatCompaction(project)}`,
    '',
    '## Instructions',
    project.goal.trim() || '(none)',
    '',
    `## Tasks (${project.tasks.length})`,
    `counts: ${formatCounts(counts(project.tasks))}`,
  ]
  if (project.tasks.length === 0) lines.push('(none)')
  for (const task of project.tasks) {
    const worker = task.childName ? ` worker=${task.childName}` : ''
    const model = task.model ? ` model=${task.model}` : ''
    const effort = task.reasoningEffort ? ` effort=${task.reasoningEffort}` : ''
    const preset = task.agentPreset ? ` preset=${task.agentPreset}` : ''
    // The retained checkout (or the reason isolation was not applied) is part of
    // the task's state a coordinator needs before re-dispatching or merging.
    const worktree = task.worktreePath
      ? ` worktree=${task.worktreePath} branch=${task.branch || '(unknown)'}`
      : task.worktreeDegraded
        ? ` worktree=off(${task.worktreeDegraded})`
        : ''
    lines.push(
      `- ${task.id} [${task.status}]${task.approved ? ' approved' : ''}${worker}${model}${effort}${preset}${worktree} ${task.title}`,
    )
    if (task.worktreeNote) lines.push(`    worktree: ${task.worktreeNote}`)
    if (task.output) lines.push(`    output: ${task.output.replace(/\n+/g, ' ').slice(0, 300)}`)
  }
  lines.push(
    '',
    '## Shared memory',
    memoryFiles.length > 0 ? memoryIndex(memoryFiles, MEMORY_INDEX_TOOL_LIMIT) : '(empty)',
  )
  return lines.join('\n')
}

function registerTools(ctx) {
  const register = (definition) => {
    ctx.tools.register(definition)
  }

  register({
    name: 'projects_list',
    description:
      'List DSH projects with their task counts. A project holds one goal, its instructions, a workspace, shared memory and a task board. Use it to find the project_id before other projects_* calls.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    execute: async () => {
      const projects = await listProjects()
      if (projects.length === 0) return 'No projects yet. Create one with projects_create.'
      return projects
        .map((project) => {
          // One tally, one formatter: `resolved` is just another status, so the
          // list cannot count accepted work as review/blocked again.
          const tally = counts(project.tasks)
          return `- ${project.id}  "${project.name}"  autonomy=${project.autonomy} concurrency=${project.concurrency}${project.worktreeIsolation ? ' worktree=on' : ''}${project.model ? ` model=${project.model}` : ''}${project.reasoningEffort ? ` effort=${project.reasoningEffort}` : ''}${project.archived ? ' archived' : ''}  tasks: ${formatCounts(tally)}`
        })
        .join('\n')
    },
  })

  register({
    name: 'projects_create',
    description:
      'Create a project: one goal, its standing instructions, the workspace its workers run in, an autonomy mode, a worker concurrency limit and an optional default worker model and reasoning effort. Returns the new project_id.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short project name.' },
        goal: {
          type: 'string',
          description: 'Standing instructions every worker receives: the goal, constraints, conventions. Up to 16000 characters.',
        },
        workspace: {
          type: 'string',
          description: 'Absolute directory workers run in. Omit to inherit the coordinator session directory.',
        },
        autonomy: {
          type: 'string',
          enum: ['manual', 'auto'],
          description:
            'manual (default): a task needs human approval on the Projects page before dispatch. auto: the coordinator may dispatch without waiting.',
        },
        concurrency: { type: 'integer', description: 'Maximum workers running at once, 1-8; defaults to 2.' },
        model: {
          type: 'string',
          description:
            'Default worker model as a "provider/model" route (the id GET /projects-api/models advertises), or a bare model id to keep the parent provider. Omit or leave empty for the host default.',
        },
        reasoningEffort: {
          type: 'string',
          description:
            'Default worker reasoning effort, as one of the ids GET /projects-api/models advertises under models[].efforts (for example "low", "high", "max"; ids are provider-owned). Omit or leave empty to let the provider apply its own default.',
        },
        agentPreset: {
          type: 'string',
          description: 'Default worker agent preset id. Omit or leave empty to inherit the parent composition.',
        },
        autoCompact: {
          type: 'boolean',
          description:
            'Compact the shared memory automatically once it exceeds memoryBudget. Defaults to true; turn it off to keep the memory append-only.',
        },
        memoryBudget: {
          type: 'integer',
          description: `Shared-memory size that triggers auto-compaction, ${MEMORY_BUDGET_MIN}-${MEMORY_BUDGET_MAX}; defaults to ${MEMORY_BUDGET}.`,
        },
        worktreeIsolation: {
          type: 'boolean',
          description:
            'Give every task its own git worktree and branch under <workspace>/.worktrees/ when the workspace is a git repository. Off by default; the repository must already ignore ".worktrees/".',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const project = await createProject(args)
      return `Created project ${project.id} "${project.name}". autonomy=${project.autonomy} concurrency=${project.concurrency} worktreeIsolation=${project.worktreeIsolation === true ? 'on' : 'off'}.`
    },
  })

  register({
    name: 'projects_update',
    description:
      'Update one project\'s settings: its name, goal, workspace, autonomy, concurrency, or its memory compaction settings (autoCompact / memoryBudget). Task status and the human verdict are not touched here — use projects_update_task for a task.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project id.' },
        name: { type: 'string', description: 'Short project name.' },
        goal: { type: 'string', description: 'Standing instructions every worker receives, up to 16000 characters.' },
        workspace: { type: 'string', description: 'Absolute directory workers run in. Empty inherits the coordinator session directory.' },
        autonomy: {
          type: 'string',
          enum: ['manual', 'auto'],
          description: 'manual: a task needs human approval before dispatch. auto: dispatch without waiting.',
        },
        concurrency: { type: 'integer', description: 'Maximum workers running at once, 1-8.' },
        autoCompact: {
          type: 'boolean',
          description:
            'Compact the shared memory automatically once it exceeds memoryBudget. Defaults to true; false keeps the memory append-only.',
        },
        memoryBudget: {
          type: 'integer',
          description: `Shared-memory size that triggers auto-compaction, ${MEMORY_BUDGET_MIN}-${MEMORY_BUDGET_MAX}; defaults to ${MEMORY_BUDGET}.`,
        },
        worktreeIsolation: {
          type: 'boolean',
          description:
            'Give every task its own git worktree and branch under <workspace>/.worktrees/ when the workspace is a git repository. Off by default; the repository must already ignore ".worktrees/".',
        },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      // Deliberately narrow: the worker route (model / reasoningEffort /
      // agentPreset) keeps its existing write paths, so this tool cannot become a
      // second, subtly different way to change how workers are dispatched.
      const patch = {
        ...(args?.name === undefined ? {} : { name: args.name }),
        ...(args?.goal === undefined ? {} : { goal: args.goal }),
        ...(args?.workspace === undefined ? {} : { workspace: args.workspace }),
        ...(args?.autonomy === undefined ? {} : { autonomy: args.autonomy }),
        ...(args?.concurrency === undefined ? {} : { concurrency: args.concurrency }),
        ...(args?.autoCompact === undefined ? {} : { autoCompact: args.autoCompact }),
        ...(args?.memoryBudget === undefined ? {} : { memoryBudget: args.memoryBudget }),
        ...(args?.worktreeIsolation === undefined ? {} : { worktreeIsolation: args.worktreeIsolation }),
      }
      const { project } = await updateProject(String(args?.project_id || ''), patch)
      return `Updated project ${project.id} "${project.name}". autonomy=${project.autonomy} concurrency=${project.concurrency} memory=${memoryBudgetOf(project)} autoCompact=${project.autoCompact !== false} worktreeIsolation=${project.worktreeIsolation === true ? 'on' : 'off'}${formatCompaction(project)}.`
    },
  })

  register({
    name: 'projects_get',
    description:
      'Read one project: instructions, workspace, autonomy, every task with its status and output, and an index of the shared memory. Use it before planning or reporting; read a memory file with projects_memory when you need its text.',
    parameters: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'Project id from projects_list.' } },
      required: ['project_id'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const project = await readProject(String(args?.project_id || ''))
      return formatProject(project, await readMemoryFiles(project.id))
    },
  })

  register({
    name: 'projects_add_task',
    description:
      'Add one task to a project board. A task is a self-contained unit a worker can finish alone; split work so tasks can run in parallel.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project id.' },
        title: { type: 'string', description: 'One-line task title.' },
        brief: {
          type: 'string',
          description: 'What the worker must do, where, and how to verify it. The worker also receives the project instructions and an index of the shared memory.',
        },
        approved: {
          type: 'boolean',
          description: 'Only for autonomy=manual: mark it approved when the user already approved it in this conversation.',
        },
        model: {
          type: 'string',
          description:
            'Optional per-task model override, as a "provider/model" route or a bare model id. Empty means inherit the project default.',
        },
        reasoningEffort: {
          type: 'string',
          description:
            'Optional per-task reasoning effort override, as an id GET /projects-api/models advertises under models[].efforts. Empty means inherit the project default.',
        },
        agentPreset: {
          type: 'string',
          description: 'Optional per-task agent preset override. Empty means inherit the project default.',
        },
      },
      required: ['project_id', 'title'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const { task } = await addTask(String(args?.project_id || ''), args)
      return `Added task ${task.id} "${task.title}" to project ${args.project_id} (status queued).`
    },
  })

  register({
    name: 'projects_update_task',
    description:
      'Update one task: its status, its recorded output, its approval flag, or its model / reasoning-effort override. Status "resolved" is the human verdict — set it only when relaying the human\'s decision; "review" takes that verdict back. Use "blocked" when a human decision is needed and "queued" to retry.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project id.' },
        task_id: { type: 'string', description: 'Task id from projects_get.' },
        status: {
          type: 'string',
          enum: STATUSES,
          description:
            'New status: queued, running, review, failed, blocked, or resolved (the human verdict).',
        },
        output: { type: 'string', description: 'Summary to record on the task (kept to 4000 characters).' },
        approved: { type: 'boolean', description: 'Approval flag for autonomy=manual projects.' },
        model: {
          type: 'string',
          description:
            'Per-task model override for the next dispatch, as a "provider/model" route or a bare model id. Empty clears it back to the project default.',
        },
        reasoningEffort: {
          type: 'string',
          description:
            'Per-task reasoning effort override for the next dispatch, as an id GET /projects-api/models advertises under models[].efforts. Empty clears it back to the project default.',
        },
        agentPreset: {
          type: 'string',
          description: 'Per-task agent preset override for the next dispatch. Empty clears it back to the project default.',
        },
      },
      required: ['project_id', 'task_id'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      // Pick the writable fields explicitly, so an argument the schema does not
      // declare (a stale caller sending `resolved`, say) cannot ride along.
      const patch = {
        ...(args?.status === undefined ? {} : { status: args.status }),
        ...(args?.output === undefined ? {} : { output: args.output }),
        ...(args?.approved === undefined ? {} : { approved: args.approved }),
        ...(args?.model === undefined ? {} : { model: args.model }),
        ...(args?.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
        ...(args?.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }),
      }
      const { task } = await updateTask(String(args?.project_id || ''), String(args?.task_id || ''), patch)
      const route = task.model ? ` model=${task.model}` : ''
      const effort = task.reasoningEffort ? ` effort=${task.reasoningEffort}` : ''
      return `Task ${task.id} is now ${task.status}${task.approved ? ' (approved)' : ''}${route}${effort}.`
    },
  })

  register({
    name: 'projects_memory',
    description:
      'Read, search, write or delete the shared memory of a project. The memory is one markdown file per topic under memory/, with a generated index: action "index" lists every file (name, one-line description, size, modified date); action "search" with a "query" finds files by keyword without returning bodies; action "read" with a "name" returns that file\'s text, and "read" alone returns the index; action "append" adds text to a file (creating it when it does not exist); action "write" replaces one file; action "delete" removes one. Record durable findings, codebase knowledge and decisions here, one file per topic, instead of repeating them in each task brief.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project id.' },
        action: {
          type: 'string',
          enum: ['index', 'read', 'search', 'append', 'write', 'delete'],
          description:
            'index (file list), search (keyword match over names, descriptions and bodies), read (default; one file with `name`, or the index without it), append to a file, replace one file, or delete one file.',
        },
        name: {
          type: 'string',
          description:
            'Memory file name, a slug such as "deployment-notes" (".md" optional). Required for append, write and delete; for read it selects one file.',
        },
        description: {
          type: 'string',
          description:
            'For append/write: one line saying what this file covers. Defaults to the first body line when the file is new, and keeps the existing description when omitted.',
        },
        type: {
          type: 'string',
          description: 'For append/write: the frontmatter `type` value; defaults to "reference".',
        },
        query: {
          type: 'string',
          description:
            'For action "search": a keyword matched case-insensitively against file names, descriptions and bodies. Returns matching names, one-line descriptions and sizes — never the bodies.',
        },
        text: { type: 'string', description: 'Text for append or write.' },
        section: {
          type: 'string',
          description:
            'Deprecated alias for "name", kept for prompts written before the per-file memory. Use "name".',
        },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const project = await readProject(String(args?.project_id || ''))
      const action = args?.action || 'read'
      const nameArg = memoryNameArg(args)
      if (action === 'index') return memoryIndexForTool(project)
      if (action === 'search') return searchMemory(await readMemoryFiles(project.id), args?.query)
      if (action === 'read') {
        // No name: the index. This is the backward-compatible read: a caller that
        // only knows `action: "read"` still gets a bounded overview, never a body.
        if (!nameArg) return memoryIndexForTool(project)
        const found = await readMemoryFile(project.id, nameArg)
        if (!found) {
          const files = await readMemoryFiles(project.id)
          throw new Error(
            `No memory file matches "${nameArg}". Files: ${files.map((file) => file.name).join(' | ') || '(none)'}. ` +
              'Archived files are searchable too (memory/archive/).',
          )
        }
        // Compaction moves files out of the live memory, not out of reach: the
        // answer says where it came from so nobody mistakes history for fact.
        const note = found.archived
          ? '\n\n(Archived: compaction moved this file into memory/archive/. It is no longer part of the memory workers see.)'
          : ''
        return `${found.file.body || '(empty file)'}${note}`
      }
      if (action === 'delete') {
        const name = memoryNameOrThrow(nameArg)
        const deleted = await deleteMemoryFile(project.id, name)
        return `Deleted memory file "${deleted.file.name}" (${deleted.file.chars} characters). The memory now has ${deleted.count} file(s), ${deleted.total} characters.`
      }
      const name = memoryNameOrThrow(nameArg)
      const value = typeof args?.text === 'string' ? args.text.trim() : ''
      if (!value) throw new Error('text is required for append or write')
      const input = { name, description: args?.description, type: args?.type, text: value }
      if (action === 'write') {
        const written = await writeMemoryFile(project.id, input)
        return `Replaced memory file "${written.file.name}" (${written.file.chars} characters).${await afterMemoryWrite(project, written)}`
      }
      const written = await appendMemoryFile(project.id, input)
      return `Appended ${value.length} characters to memory file "${written.file.name}" (${written.file.chars} characters).${await afterMemoryWrite(project, written)}`
    },
  })

  register({
    name: 'projects_dispatch',
    description:
      'Dispatch one queued task to a worker subagent. The worker gets the project instructions, an index of the shared memory and the task brief, runs in the project workspace, and reports its final message back onto the task. Returns immediately: the coordinator stays free.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project id.' },
        task_id: { type: 'string', description: 'Task id to dispatch.' },
      },
      required: ['project_id', 'task_id'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) =>
      dispatchTask(ctx, exec, String(args?.project_id || ''), String(args?.task_id || '')),
  })
}

// ---------------------------------------------------------------------------
// Plugin

export function apply(ctx) {
  // The effect body runs now and returns the teardown: unloading the plugin
  // cancels every worker it started instead of leaving orphaned children.
  ctx.effect(() => () => {
    for (const controller of controllers.values()) {
      try {
        controller.abort()
      } catch {
        // Already settled.
      }
    }
    controllers.clear()
  }, 'projects: stop workers on unload')

  let disposeRoute
  try {
    disposeRoute = ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: createRouteHandler(ctx) })
  } catch (error) {
    console.warn(`projects: could not register ${ROUTE}: ${messageOf(error)}`)
  }
  if (disposeRoute) ctx.effect(() => disposeRoute, 'projects: /projects-api routes')

  registerTools(ctx)

  // Worker settlement: `subagent/end` carries the child's final assistant
  // message, which becomes the task output the human reviews.
  if (ctx.get('subagents')) {
    try {
      ctx.on('subagent/end', (info) => {
        void settleWorker(info).catch((error) => {
          console.warn(`projects: could not record worker ${info?.id}: ${messageOf(error)}`)
        })
      })
    } catch (error) {
      console.warn(`projects: subagent/end listener unavailable: ${messageOf(error)}`)
    }
  }
}

/**
 * Test seam. Compaction is otherwise reachable only through a memory write, and
 * two writes cannot be interleaved deterministically from outside the module —
 * which is exactly what the single-flight guard has to be tested against.
 * Nothing in the plugin calls this export.
 */
export { compactMemory }
