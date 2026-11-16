/**
 * Projects — Host half.
 *
 * A project is a durable container for one goal: instructions, a workspace, a
 * shared memory file, and a board of tasks. The Host half owns the data (under
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
 *   $DSH_HOME/projects/<projectId>/project.json   project + tasks
 *   $DSH_HOME/projects/<projectId>/memory.md     shared project memory
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const inject = ['webServer', 'tools']

const ROUTE = '/projects-api'
const BODY_LIMIT = 2 * 1024 * 1024
const MAX_GOAL = 16_000
const MAX_BRIEF = 8_000
const MAX_OUTPUT = 4_000
/**
 * Healthy size of the shared memory. Appends past this still succeed — silently
 * dropping a worker's findings would be worse than a fat file — but the tool
 * result says so, so the coordinator can compress instead of growing it forever.
 */
const MEMORY_BUDGET = 64_000
/**
 * Absolute ceiling for one write. This is a runaway guard, not the budget: it
 * has to stay above whatever is already on disk, because slicing a file at a
 * value below its current size would delete stored memory. The page round-trips
 * the whole memory through `POST /projects/:id/memory`, so a ceiling under the
 * current size would also make the memory editor unsaveable.
 */
const MAX_MEMORY = 200_000
/** Bounds for the per-project `memoryBudget` override. */
const MEMORY_BUDGET_MIN = 4_000
const MEMORY_BUDGET_MAX = MAX_MEMORY
/**
 * Compaction aims *below* the budget rather than at it, so a project does not
 * re-compact on the very next append. 60% of the budget leaves room for roughly
 * a dozen normal-sized sections.
 */
const MEMORY_TARGET_RATIO = 0.6
/**
 * Hard cap on the memory index injected into a worker prompt. The prompt has to
 * stay small no matter how large the memory grows, so the index is truncated
 * rather than the prompt.
 */
const MEMORY_INDEX_LIMIT = 2_000
/** The same index for the tool: the discovery path may be a little longer. */
const MEMORY_INDEX_TOOL_LIMIT = 8_000
/**
 * The index's one-line description is a section's first non-empty body line,
 * markdown stripped and cut at this many characters. Long enough to tell two
 * sections apart, short enough that a full index stays cheap.
 */
const MEMORY_DESCRIPTION_MAX = 80
/** Search lists at most this many sections; the rest are counted, not listed. */
const MEMORY_SEARCH_LIMIT = 10
/**
 * A section title containing one of these markers is history rather than
 * current fact. It stays readable by name, but the index and search hide it so
 * a superseded decision cannot be mistaken for the live one.
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
 * System statuses only. `status` is written by the host itself (add → queued,
 * dispatch → running, settle → review|failed) and by the coordinator tool
 * (blocked, retry). The human verdict — "this task counts as finished" — lives
 * in `task.resolved`, and the page may write nothing else.
 */
const STATUSES = ['queued', 'running', 'review', 'failed', 'blocked']
/** The single task field the browser is allowed to write. */
const HUMAN_TASK_FIELDS = ['resolved']
const AUTONOMY = ['manual', 'auto']
/**
 * What `DELETE /projects-api/projects/:id/tasks/:taskId?session=` may do to the
 * worker session behind the task.
 *
 * Only `archive` exists, because DeepSeek Harness has no session deletion at
 * all. `sessions` (the `SessionStore`) offers create/prepare/enter/announce/
 * get/list/fork/flush and `sessionPersistence` offers create/open/read/append/
 * flush/stat/list — no method removes a stored log — and the product states the
 * gap outright ("会话可以归档但绝不会被删除",
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
 * single-flight per project: a second append that lands mid-run must not start a
 * second pass over the same file (two passes would archive the same sections
 * twice and could interleave their writes). The entry is cleared in a `finally`,
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

function memoryFile(id) {
  return join(projectDir(id), 'memory.md')
}

/**
 * Sections moved out of `memory.md` by auto-compaction. Append-only and never
 * injected anywhere: it is the "nothing is lost" half of compaction, so a human
 * can still read what was summarised away.
 */
function memoryArchiveFile(id) {
  return join(projectDir(id), 'memory-archive.md')
}

/** The memory as it was just before the last compaction, for manual recovery. */
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
  // Legacy rows used `status: 'done'` for "the human accepted this task". Status
  // is now system-only, so a stored `done` migrates to review + resolved on read.
  const legacyDone = raw.status === 'done'
  const task = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('t'),
    title: text(raw.title, 200) || 'Untitled task',
    brief: text(raw.brief, MAX_BRIEF),
    status: legacyDone ? 'review' : STATUSES.includes(raw.status) ? raw.status : 'queued',
    resolved: legacyDone || raw.resolved === true,
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

async function readMemory(id) {
  try {
    return await readFile(memoryFile(id), 'utf8')
  } catch {
    return ''
  }
}

async function writeMemory(id, contents) {
  await mkdir(projectDir(id), { recursive: true })
  const text = String(contents ?? '')
  const next = text.length > MAX_MEMORY ? text.slice(0, MAX_MEMORY) : text
  await writeFileAtomic(memoryFile(id), next)
  return { length: next.length, truncated: next.length < text.length }
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

/**
 * The index's one-line description: the first non-empty body line, markdown
 * stripped and capped at `MEMORY_DESCRIPTION_MAX` characters. `''` when the
 * section has no body, so the index can fall back to a title-only line.
 */
function memoryDescription(body) {
  const first = String(body ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!first) return ''
  const plain = plainMemoryLine(first)
  if (!plain) return ''
  return plain.length > MEMORY_DESCRIPTION_MAX
    ? `${plain.slice(0, MEMORY_DESCRIPTION_MAX).trimEnd()}…`
    : plain
}

/** The `YYYY-MM-DD` date a section title carries, or '' when it carries none. */
function memoryDate(title) {
  const match = /\b(\d{4}-\d{2}-\d{2})\b/.exec(String(title ?? ''))
  return match ? match[1] : ''
}

/** True for a section whose title marks it as history rather than current fact. */
function isStaleMemorySection(title) {
  const lower = String(title ?? '').toLowerCase()
  return MEMORY_STALE_MARKERS.some((marker) => lower.includes(marker))
}

/**
 * Split the memory into its `## ` sections. Everything before the first heading
 * is the preamble and is reported separately, so a section lookup never has to
 * guess what to do with loose text.
 *
 * Each section also carries what the index needs to describe it without
 * injecting its body: a one-line `description`, the `date` in its title, and
 * whether the title marks it `stale`.
 */
function memorySections(memory) {
  const sections = []
  let current = null
  for (const line of String(memory ?? '').split('\n')) {
    if (line.startsWith('## ')) {
      current = { title: line.slice(3).trim(), lines: [] }
      sections.push(current)
      continue
    }
    if (current) current.lines.push(line)
  }
  return sections.map((section) => {
    const body = section.lines.join('\n').trim()
    return {
      title: section.title,
      body,
      chars: body.length,
      description: memoryDescription(body),
      date: memoryDate(section.title),
      stale: isStaleMemorySection(section.title),
    }
  })
}

function memoryPreamble(memory) {
  const text = String(memory ?? '')
  if (text.startsWith('## ')) return ''
  const at = text.indexOf('\n## ')
  return (at === -1 ? text : text.slice(0, at)).trim()
}

/** One index line at the requested level of detail. */
function memoryIndexEntry(section, mode) {
  if (mode === 'titles') return `· ${section.title}`
  const size = `${section.chars} chars`
  const date = section.date ? `，${section.date}` : ''
  if (mode === 'no-description' || !section.description) return `· ${section.title}（${size}${date}）`
  return `· ${section.title} — ${section.description}（${size}${date}）`
}

/**
 * The "marked stale" footnote: titles only, never descriptions, because these
 * sections are history. Bounded so a project with dozens of them cannot blow
 * the index on its own.
 */
function staleMemoryLine(stale) {
  const titles = stale.map((section) => section.title).join(' | ')
  let line = `- ${stale.length} section(s) marked stale (superseded/archived; still readable by name): ${titles}`
  if (line.length > 500) line = `${line.slice(0, 500).trimEnd()}…`
  return line
}

/**
 * The memory as an index: one line per section with a one-line description, its
 * size and the date in its title — never the body. This is what a worker prompt
 * gets, so the prompt stays bounded no matter how much history accumulates.
 *
 * A described index is longer than a bare title list, so the format degrades in
 * a fixed order until it fits `limit`:
 *
 *   1. title + description + size + date      (full)
 *   2. title + size + date                    (descriptions dropped)
 *   3. title only                             (sizes and dates dropped)
 *   4. title only, truncated                  (whole sections dropped + counted)
 *
 * The first level whose text fits wins, and the header names the level in use.
 * Sections whose title is marked `[superseded]`/`[archived]` are left out of the
 * list. `listStale` adds the "marked stale" footnote (titles only) — the tool's
 * index action asks for it so a coordinator can still find history by name; the
 * worker prompt does not, because workers act on current knowledge.
 */
function memoryIndex(memory, limit = MEMORY_INDEX_LIMIT, { listStale = false } = {}) {
  const text = String(memory ?? '').trim()
  if (!text) return '(empty)'
  const sections = memorySections(text)
  if (sections.length === 0) {
    return `${text.length} characters, no "## " headings. Read it with projects_memory {action:"read"}.`
  }
  const live = sections.filter((section) => !section.stale)
  const stale = sections.filter((section) => section.stale)
  const header =
    `${live.length} section(s), ${text.length} characters. ` +
    'Read one with projects_memory {action:"read", section:"<title>"} — do not assume you know what a section says. ' +
    'Find one with projects_memory {action:"search", query:"<keyword>"}.'
  const preamble = memoryPreamble(text)
  const preambleLine = preamble ? `- (preamble before the first heading) (${preamble.length} chars)` : ''
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
    if (preambleLine) lines.push(preambleLine)
    for (const section of live) lines.push(memoryIndexEntry(section, level.mode))
    if (staleLine) lines.push(staleLine)
    const candidate = lines.join('\n')
    if (candidate.length <= limit) return candidate
  }
  // Level 4. Reserve room for the "…and N more" note so the note itself cannot
  // push the result past the cap; the truncated header is longer than level 3's,
  // so this branch always drops at least one section.
  const truncatedHeader = `${header} Titles only (descriptions and sizes omitted), truncated to fit the ${limit}-character index cap.`
  const fixedLength =
    truncatedHeader.length +
    (preambleLine ? preambleLine.length + 1 : 0) +
    (staleLine ? staleLine.length + 1 : 0)
  const room = Math.max(0, limit - fixedLength - 2 - 200)
  const shown = []
  let used = 0
  for (const section of live) {
    const entry = memoryIndexEntry(section, 'titles')
    if (used + entry.length + 1 > room) break
    shown.push(entry)
    used += entry.length + 1
  }
  const omitted = live.length - shown.length
  const lines = [truncatedHeader]
  if (preambleLine) lines.push(preambleLine)
  lines.push(...shown)
  if (omitted > 0) lines.push(`- …and ${omitted} more section(s) not listed (index capped at ${limit} characters).`)
  if (staleLine) lines.push(staleLine)
  return lines.join('\n')
}

/**
 * Find sections by keyword: case-insensitive substring match over the title and
 * the body, stale sections excluded. Returns titles, one-line descriptions and
 * sizes — never bodies — so a search costs a fraction of a full read.
 */
function searchMemory(memory, query, limit = MEMORY_SEARCH_LIMIT) {
  const needle = String(query ?? '').trim()
  if (!needle) throw new Error('query is required for action "search"')
  const text = String(memory ?? '').trim()
  if (!text) return `No memory section matches "${needle}". The shared memory is empty.`
  const sections = memorySections(text)
  const live = sections.filter((section) => !section.stale)
  const wanted = needle.toLowerCase()
  const matches = live.filter(
    (section) => section.title.toLowerCase().includes(wanted) || section.body.toLowerCase().includes(wanted),
  )
  if (matches.length === 0) {
    const stale = sections.length - live.length
    return (
      `No memory section matches "${needle}". ${live.length} live section(s) in memory` +
      `${stale ? `, ${stale} stale section(s) excluded` : ''} — ` +
      'use projects_memory {action:"index"} to see them all.'
    )
  }
  const shown = matches.slice(0, limit)
  const header =
    `${matches.length} section(s) match "${needle}"` +
    (shown.length < matches.length ? `, showing the first ${shown.length}` : '') +
    '. Read one with projects_memory {action:"read", section:"<title>"}.'
  const lines = [header, ...shown.map((section) => memoryIndexEntry(section, 'full'))]
  if (shown.length < matches.length) {
    lines.push(`- …and ${matches.length - shown.length} more section(s) match; narrow the query or use action:"index".`)
  }
  return lines.join('\n')
}

/**
 * Find one section by title. Deliberately forgiving: exact match first, then
 * prefix, then "contains", all case-insensitive, because callers copy titles by
 * hand and often shorten them.
 */
function findMemorySection(memory, needle) {
  const wanted = String(needle ?? '').trim().toLowerCase()
  if (!wanted) return null
  const sections = memorySections(memory)
  return (
    sections.find((section) => section.title.toLowerCase() === wanted) ||
    sections.find((section) => section.title.toLowerCase().startsWith(wanted)) ||
    sections.find((section) => section.title.toLowerCase().includes(wanted)) ||
    null
  )
}

/** A warning suffix for memory writes, or '' when everything is fine. */
function memoryWarning({ length, truncated }, budget = MEMORY_BUDGET) {
  const notes = []
  if (truncated) {
    notes.push(
      `WARNING: the memory hit the ${MAX_MEMORY}-character write ceiling and the tail was cut (only the tail: nothing before it was dropped).`,
    )
  }
  if (length > budget) {
    notes.push(
      `WARNING: the shared memory is now ${length} characters, ${length - budget} over the ${budget}-character budget. ` +
        'Workers only receive an index, but the file should be compressed: read it with action "index", then replace it with a condensed version using action "write".',
    )
  }
  return notes.length ? ` ${notes.join(' ')}` : ''
}

// ---------------------------------------------------------------------------
// Automatic memory compaction
//
// The memory is an append-only log, so it only ever grows. Workers get an index
// (never the text) and the coordinator reads sections, so a fat file is not
// fatal — but it does mean the project's durable knowledge is buried in a
// changelog, and every "read the whole memory" eventually costs a context
// window. So the host compacts on its own once the file crosses the budget.
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
//  - Archiving whole sections cannot lose a fact: the moved text is kept verbatim
//    in `memory-archive.md`. A model rewrite can, and silently.
//
// So: whole oldest sections move to `memory-archive.md` until the remaining file
// fits the target. Nothing is summarised, split or dropped.

/** The per-project budget, clamped so a hand-edited project.json cannot disable it. */
function memoryBudgetOf(project) {
  return intIn(project?.memoryBudget, MEMORY_BUDGET_MIN, MEMORY_BUDGET_MAX, MEMORY_BUDGET)
}

/**
 * Split the memory into preamble + `## ` sections, keeping each section's text
 * verbatim (the index/read paths only need titles and sizes, but archiving has to
 * move the original bytes). A `## ` line inside a body splits it, exactly like
 * `memorySections`, so the two views never disagree about what a section is.
 */
function memoryBlocks(memory) {
  const source = String(memory ?? '')
  if (!source.trim()) return []
  const starts = []
  const heading = /^## /gm
  let match
  while ((match = heading.exec(source)) !== null) starts.push(match.index)
  if (starts.length === 0) return [{ title: null, body: source }]
  const blocks = []
  const preamble = source.slice(0, starts[0])
  if (preamble.trim()) blocks.push({ title: null, body: preamble })
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : source.length
    const chunk = source.slice(starts[index], end)
    const newline = chunk.indexOf('\n')
    const title = (newline === -1 ? chunk.slice(3) : chunk.slice(3, newline)).trim()
    blocks.push({ title, body: chunk })
  }
  return blocks
}

/**
 * Decide what to move. Keeps the newest sections that fit `target` and archives
 * the older ones; the newest section is always kept even when it alone exceeds
 * the target, because splitting a section would corrupt it. Returns null when
 * there is nothing safe to move (no sections, or only one).
 */
function planArchive(memory, target) {
  const blocks = memoryBlocks(memory)
  const preamble = blocks.length > 0 && blocks[0].title === null ? blocks[0] : null
  const sections = preamble ? blocks.slice(1) : blocks
  if (sections.length <= 1) return null
  const kept = []
  let used = preamble ? preamble.body.length : 0
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index]
    if (kept.length > 0 && used + section.body.length > target) break
    kept.unshift(section)
    used += section.body.length
  }
  const moved = sections.slice(0, sections.length - kept.length)
  if (moved.length === 0) return null
  const remaining = [preamble ? preamble.body.trimEnd() : '', ...kept.map((section) => section.body.trimEnd())]
    .filter((part) => part)
    .join('\n\n')
  return {
    remaining: `${remaining}\n`,
    moved,
    archivedChars: moved.reduce((total, section) => total + section.body.length, 0),
  }
}

/** The archive's run header plus the moved sections, verbatim. */
function archiveRunBlock(plan, before, budget) {
  const stamp = new Date().toISOString()
  const titles = plan.moved.map((section) => section.title || '(preamble)').join(' | ')
  return [
    `## Compaction ${stamp} — ${before.length} → ${plan.remaining.length} characters, budget ${budget}`,
    `Moved ${plan.moved.length} section(s): ${titles}`,
    '',
    ...plan.moved.map((section) => section.body.trimEnd()),
    '',
  ].join('\n')
}

async function readMemoryArchive(id) {
  try {
    return await readFile(memoryArchiveFile(id), 'utf8')
  } catch {
    return ''
  }
}

/**
 * A bounded list of what compaction moved out, appended to the tool's index so
 * an archived section stays discoverable. Deliberately *not* part of the worker
 * prompt's index: workers act on current knowledge, and archived history is
 * something the coordinator looks up on purpose.
 */
function archiveSummary(archive, limit = 2_000) {
  const sections = memorySections(archive).filter((section) => !section.title.startsWith('Compaction '))
  if (sections.length === 0) return ''
  const header =
    `${sections.length} archived section(s) in memory-archive.md — moved out by compaction, not injected into prompts. ` +
    'Read one with action "read", section:"<title>".'
  const lines = [header]
  let used = header.length
  for (const section of sections) {
    const entry = `- ${section.title} (${section.chars} chars)`
    if (used + entry.length + 1 > limit) {
      lines.push(`- …and ${sections.length - (lines.length - 1)} more archived section(s) not listed.`)
      break
    }
    lines.push(entry)
    used += entry.length + 1
  }
  return lines.join('\n')
}

/**
 * Compact one project's memory down to `MEMORY_TARGET_RATIO` of its budget.
 *
 * Order matters: back up → append the archive → write the shorter memory →
 * verify the write. The memory is only replaced after the archive holds the
 * moved text, and a rewrite that does not actually shrink the file (or that
 * comes back empty) is discarded rather than applied. Any failure after the
 * memory write restores the pre-compaction text, so a compaction can never be
 * the thing that loses memory.
 *
 * @returns a result object; `skipped` is null on success.
 */
async function compactMemory(projectId) {
  const id = String(projectId)
  if (compacting.has(id)) return { skipped: 'in_flight' }
  compacting.add(id)
  let before = ''
  let budget = MEMORY_BUDGET
  let wrote = false
  try {
    const project = await readProject(id)
    budget = memoryBudgetOf(project)
    before = await readMemory(id)
    if (before.length <= budget) {
      return { skipped: 'under_budget', before: before.length, after: before.length, budget }
    }
    const target = Math.max(1, Math.floor(budget * MEMORY_TARGET_RATIO))
    const plan = planArchive(before, target)
    if (!plan) {
      return { skipped: 'nothing_to_archive', before: before.length, after: before.length, budget }
    }
    if (!plan.remaining.trim() || plan.remaining.length >= before.length) {
      return {
        skipped: 'rolled_back',
        before: before.length,
        after: before.length,
        budget,
        reason: 'the archived result was empty or not shorter than the original',
      }
    }
    await writeFileAtomic(memoryBackupFile(id), before)
    await writeFileAtomic(memoryArchiveFile(id), `${await readMemoryArchive(id)}${archiveRunBlock(plan, before, budget)}`)
    await writeFileAtomic(memoryFile(id), plan.remaining)
    wrote = true
    const check = await readMemory(id)
    if (check !== plan.remaining) {
      await writeFileAtomic(memoryFile(id), before)
      wrote = false
      return {
        skipped: 'rolled_back',
        before: before.length,
        after: before.length,
        budget,
        reason: 'the rewritten memory did not read back identically',
      }
    }
    const record = {
      at: Date.now(),
      before: before.length,
      after: plan.remaining.length,
      archived: plan.moved.length,
    }
    // Re-read before saving: compaction can run while a task settles, and a stale
    // copy would undo that write.
    const latest = await readProject(id)
    latest.lastCompaction = record
    latest.updatedAt = Date.now()
    await writeProject(latest)
    return { skipped: null, ...record, budget }
  } catch (error) {
    if (wrote) {
      try {
        await writeFileAtomic(memoryFile(id), before)
      } catch {
        // The backup on disk is still the pre-compaction text.
      }
    }
    return { skipped: 'error', before: before.length, after: before.length, budget, reason: messageOf(error) }
  } finally {
    compacting.delete(id)
  }
}

/** Human/agent-facing sentence for a compaction result, or '' when nothing happened. */
function compactionNote(result) {
  if (!result) return ''
  if (!result.skipped) {
    const still = result.after > result.budget
      ? ` It is still over the ${result.budget}-character budget: the remaining sections are each too large to split.`
      : ''
    return ` Auto-compacted the shared memory: ${result.before} → ${result.after} characters (${result.archived} section(s) moved to memory-archive.md).${still}`
  }
  if (result.skipped === 'in_flight') {
    return ' A compaction is already running for this project; it will finish on its own.'
  }
  if (result.skipped === 'under_budget') return ''
  if (result.skipped === 'nothing_to_archive') {
    return ` The memory is ${result.before} characters, over its ${result.budget}-character budget, but there is nothing safe to archive: a single section is never split.`
  }
  if (result.skipped === 'rolled_back') {
    return ` Auto-compaction was rolled back (${result.reason}); the memory is unchanged at ${result.before} characters.`
  }
  return ` Auto-compaction failed (${result.reason}); the memory is unchanged at ${result.before} characters.`
}

/**
 * The one hook every memory write goes through: warn, then compact if the file
 * is over budget and the project allows it. Never throws — a write that already
 * landed must not be reported as failed because housekeeping could not run.
 */
async function afterMemoryWrite(project, written) {
  const budget = memoryBudgetOf(project)
  const warning = memoryWarning(written, budget)
  if (written.length <= budget) return warning
  if (project.autoCompact === false) {
    return `${warning} Auto-compaction is off for this project, so the file stays over budget.`
  }
  try {
    return `${warning}${compactionNote(await compactMemory(project.id))}`
  } catch (error) {
    return `${warning} Auto-compaction failed (${messageOf(error)}); the memory is unchanged.`
  }
}

function counts(tasks) {
  const result = { queued: 0, running: 0, review: 0, failed: 0, blocked: 0 }
  for (const task of tasks) result[task.status] = (result[task.status] || 0) + 1
  return result
}

function summarize(project) {
  return {
    id: project.id,
    name: project.name,
    workspace: project.workspace,
    autonomy: project.autonomy,
    concurrency: project.concurrency,
    archived: project.archived,
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
  project.updatedAt = Date.now()
  await writeProject(project)
  return project
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
 * write every field, including `resolved` — but the browser never reaches it
 * directly: the page goes through `resolveTask` below, which narrows the patch
 * to `resolved` before calling in here.
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
  if (patch?.resolved !== undefined) task.resolved = patch.resolved === true
  if (patch?.model !== undefined) task.model = modelValue(patch.model)
  if (patch?.agentPreset !== undefined) task.agentPreset = presetValue(patch.agentPreset)
  if (patch?.reasoningEffort !== undefined) task.reasoningEffort = effortValue(patch.reasoningEffort)
  task.updatedAt = Date.now()
  project.updatedAt = Date.now()
  await writeProject(project)
  return { project, task }
}

/**
 * The human write face: the page may only flip `resolved`. Anything else in the
 * body is rejected with 400 instead of being ignored, so a stale browser bundle
 * that still tries to PATCH `status` fails loudly rather than silently believing
 * it changed the board.
 */
async function resolveTask(projectId, taskId, patch) {
  const body = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const foreign = Object.keys(body).filter((key) => !HUMAN_TASK_FIELDS.includes(key))
  if (foreign.length > 0) {
    throw httpError(
      400,
      `only "resolved" is writable from the page (rejected: ${foreign.join(', ')})`,
    )
  }
  if (body.resolved === undefined) throw httpError(400, 'resolved_required')
  if (typeof body.resolved !== 'boolean') throw httpError(400, 'resolved_must_be_boolean')
  return updateTask(projectId, taskId, { resolved: body.resolved })
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

/**
 * Remove one task from the board, optionally archiving its worker session.
 *
 * Order: the session is archived *before* the task is spliced out and written.
 * The task row holds the only reference to `childSessionId`, so archiving after
 * the write would lose the id if that write failed. With this order a failure
 * is recoverable in both directions: a failed archive leaves the task untouched
 * (nothing to undo), and a failed project write leaves an archived session whose
 * task is still on the board — the page's `/sessions/restore` route unarchives
 * it, and retrying the delete is safe because archiving an already-archived id
 * is a no-op.
 */
async function removeTask(ctx, projectId, taskId, action = '') {
  const project = await readProject(projectId)
  const index = project.tasks.findIndex((candidate) => candidate.id === taskId)
  if (index < 0) throw httpError(404, 'task_not_found')
  const task = project.tasks[index]
  const session = action === 'archive' ? await archiveTaskSession(ctx, project, task) : null
  project.tasks.splice(index, 1)
  project.updatedAt = Date.now()
  await writeProject(project)
  return { project, session }
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

function workerPrompt(project, task, memory) {
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
    // An index, not the text. The memory is a long append-only log; injecting it
    // whole made every worker pay for history it does not need. The worker can
    // pull the one section it needs with projects_memory.
    memoryIndex(memory),
    '',
    `The list above is an index of the shared memory, not its contents. Read a section before relying on it: projects_memory {project_id:"${project.id}", action:"read", section:"<title>"}.`,
    '',
    '## Your task',
    `Title: ${task.title}`,
  ]
  if (task.brief.trim()) lines.push('', task.brief.trim())
  lines.push(
    '',
    '## How to work',
    project.workspace ? `- Work inside ${project.workspace}.` : '- Work in the current directory.',
    '- Keep changes scoped to this task; do not rewrite unrelated code.',
    `- Before finishing, append what later tasks must know (findings, decisions, gotchas) to the shared memory with the projects_memory tool: project_id "${project.id}", action "append".`,
    '- Do not change the task status; the runner records your final message as the task output.',
    '- If the task cannot be completed, say what blocked it and what a human must decide.',
    '- Finish with a short report: what you changed, where, and how you verified it.',
  )
  return lines.join('\n')
}

async function dispatchTask(ctx, exec, projectId, taskId) {
  const subagents = ctx.get('subagents')
  if (!subagents) throw new Error('The subagent service is unavailable in this profile, so no worker can start.')
  if (!exec?.agent) throw new Error('projects_dispatch needs a calling agent (exec.agent was undefined).')
  const project = await readProject(projectId)
  if (project.archived) return `Project ${project.id} is archived. Unarchive it before dispatching.`
  const task = project.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new Error(`Unknown task ${taskId} in project ${project.id}.`)
  if (task.status === 'running') {
    return `Task ${task.id} is already running as ${task.childName || task.childSessionId || 'a worker'}.`
  }
  if (project.autonomy === 'manual' && !task.approved) {
    return `Task ${task.id} needs human approval first: project autonomy is "manual". Ask the user to approve it on the Projects page, then call projects_dispatch again.`
  }
  const running = project.tasks.filter((candidate) => candidate.status === 'running').length
  if (running >= project.concurrency) {
    return `Concurrency limit reached (${running}/${project.concurrency} workers running). Wait for one to settle before dispatching ${task.id}.`
  }
  const memory = await readMemory(project.id)
  const controller = new AbortController()
  const cwd = project.workspace && (await isDirectory(project.workspace)) ? project.workspace : undefined
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
      prompt: [{ type: 'text', text: workerPrompt(project, task, memory) }],
      parent: exec.agent,
      ...(cwd === undefined ? {} : { cwd }),
      ...(agentPreset ? { agentPreset } : {}),
      ...(agentOptions === undefined ? {} : { agentOptions }),
      signal: controller.signal,
      delivery: 'parent',
    })
  } catch (error) {
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
  return `Dispatched task ${task.id} to worker ${started.name} (session ${started.childId})${routeNote}${effortNote}${presetNote}. It runs in the background; its final message lands on the task when it settles.`
}

async function settleWorker(info) {
  if (!info || typeof info.id !== 'string') return
  const projects = await listProjects()
  for (const project of projects) {
    const task = project.tasks.find((candidate) => candidate.childSessionId === info.id)
    if (!task) continue
    if (task.status !== 'running') return
    task.status = info.stopReason === 'completed' ? 'review' : 'failed'
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
      const memory = await readMemory(project.id)
      return { status: 200, body: { project, memory } }
    }
    if (method === 'PATCH') {
      const body = await readJson(req)
      const project = await updateProject(projectId, body)
      return { status: 200, body: { project } }
    }
    throw httpError(405, 'method_not_allowed')
  }

  // /projects/:id/memory
  if (parts.length === 3 && parts[2] === 'memory') {
    if (method === 'GET') {
      const project = await readProject(projectId)
      return { status: 200, body: { memory: await readMemory(project.id) } }
    }
    if (method === 'POST') {
      // Read the body before touching the store: `readJson` attaches its
      // listeners synchronously, so the request cannot lose a chunk that
      // arrives while the project file is still being read.
      const body = await readJson(req)
      if (typeof body?.text !== 'string') throw httpError(400, 'text_required')
      const project = await readProject(projectId)
      const written = await writeMemory(project.id, body.text)
      // The page's memory editor is a write path like any other, so it compacts
      // too. `saved` stays first so the existing page keeps working unchanged.
      const compaction = await afterMemoryWrite(project, written)
      return { status: 200, body: { saved: true, length: written.length, compaction } }
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
      const { session } = await removeTask(ctx, projectId, taskId, action)
      return { status: 200, body: { deleted: true, session } }
    }
    throw httpError(405, 'method_not_allowed')
  }

  // /projects/:id/tasks/:taskId/approve — the manual-mode gate. One field, one
  // value, its own entry point: PATCH stays `resolved`-only and this stays
  // `approved: true`-only, so neither door can be used to write the other field.
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

function formatProject(project, memory) {
  const lines = [
    `Project ${project.id} — ${project.name}`,
    `workspace: ${project.workspace || '(inherited)'}`,
    `autonomy: ${project.autonomy}, concurrency: ${project.concurrency}${project.archived ? ', ARCHIVED' : ''}`,
    `worker model: ${project.model || '(host default)'}${project.reasoningEffort ? `, effort: ${project.reasoningEffort}` : ''}${project.agentPreset ? `, preset: ${project.agentPreset}` : ''}`,
    `memory: budget ${memoryBudgetOf(project)}, auto-compaction ${project.autoCompact === false ? 'off' : 'on'}${formatCompaction(project)}`,
    '',
    '## Instructions',
    project.goal.trim() || '(none)',
    '',
    `## Tasks (${project.tasks.length})`,
  ]
  if (project.tasks.length === 0) lines.push('(none)')
  for (const task of project.tasks) {
    const worker = task.childName ? ` worker=${task.childName}` : ''
    const model = task.model ? ` model=${task.model}` : ''
    const effort = task.reasoningEffort ? ` effort=${task.reasoningEffort}` : ''
    const preset = task.agentPreset ? ` preset=${task.agentPreset}` : ''
    lines.push(
      `- ${task.id} [${task.status}]${task.resolved ? ' resolved' : ''}${task.approved ? ' approved' : ''}${worker}${model}${effort}${preset} ${task.title}`,
    )
    if (task.output) lines.push(`    output: ${task.output.replace(/\n+/g, ' ').slice(0, 300)}`)
  }
  lines.push('', '## Shared memory', memory.trim() ? memoryIndex(memory, MEMORY_INDEX_TOOL_LIMIT) : '(empty)')
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
          const tally = counts(project.tasks)
          const parts = Object.entries(tally)
            .filter(([, value]) => value > 0)
            .map(([status, value]) => `${value} ${status}`)
          const resolved = project.tasks.filter((task) => task.resolved).length
          if (resolved > 0) parts.push(`${resolved} resolved`)
          return `- ${project.id}  "${project.name}"  autonomy=${project.autonomy} concurrency=${project.concurrency}${project.model ? ` model=${project.model}` : ''}${project.reasoningEffort ? ` effort=${project.reasoningEffort}` : ''}${project.archived ? ' archived' : ''}  tasks: ${parts.join(', ') || 'none'}`
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
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const project = await createProject(args)
      return `Created project ${project.id} "${project.name}". autonomy=${project.autonomy} concurrency=${project.concurrency}.`
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
      }
      const project = await updateProject(String(args?.project_id || ''), patch)
      return `Updated project ${project.id} "${project.name}". autonomy=${project.autonomy} concurrency=${project.concurrency} memory=${memoryBudgetOf(project)} autoCompact=${project.autoCompact !== false}${formatCompaction(project)}.`
    },
  })

  register({
    name: 'projects_get',
    description:
      'Read one project: instructions, workspace, autonomy, every task with its status and output, and an index of the shared memory. Use it before planning or reporting; read a memory section with projects_memory when you need its text.',
    parameters: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'Project id from projects_list.' } },
      required: ['project_id'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const project = await readProject(String(args?.project_id || ''))
      return formatProject(project, await readMemory(project.id))
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
      'Update one task: its system status, its recorded output, its approval flag, or its model / reasoning-effort override. The human resolves a task on the Projects page — you cannot set "resolved". Use "blocked" when a human decision is needed and "queued" to retry.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project id.' },
        task_id: { type: 'string', description: 'Task id from projects_get.' },
        status: {
          type: 'string',
          enum: ['queued', 'running', 'review', 'failed', 'blocked'],
          description: 'New system status. "resolved" is the human verdict and is not writable here.',
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
      // Pick the coordinator-writable fields explicitly: `resolved` is the
      // human's call, so it must not ride along even if a caller sends it.
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
      return `Task ${task.id} is now ${task.status}${task.resolved ? ' (resolved)' : ''}${task.approved ? ' (approved)' : ''}${route}${effort}.`
    },
  })

  register({
    name: 'projects_memory',
    description:
      'Read, search or write the shared memory of a project. The memory is a long append-only log, so read it by section: action "index" lists each section\'s title, one-line description and size; action "search" with a "query" finds sections by keyword without returning bodies; action "read" with a "section" returns just that section; action "read" alone returns the whole file. Record durable findings, codebase knowledge and decisions here instead of repeating them in each task brief.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project id.' },
        action: {
          type: 'string',
          enum: ['index', 'read', 'search', 'append', 'write'],
          description: 'index (titles + one-line descriptions), search (keyword match over titles and bodies), read (default; whole file, or one section with `section`), append a section, or replace all.',
        },
        section: {
          type: 'string',
          description: 'For action "read": a section title, or a distinctive part of one. Case-insensitive; exact, prefix and substring matches all work.',
        },
        query: {
          type: 'string',
          description: 'For action "search": a keyword matched case-insensitively against section titles and bodies. Returns matching titles, one-line descriptions and sizes — never the bodies.',
        },
        text: { type: 'string', description: 'Text for append or write.' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const project = await readProject(String(args?.project_id || ''))
      const action = args?.action || 'read'
      const memory = await readMemory(project.id)
      if (action === 'index') {
        const live = memoryIndex(memory, MEMORY_INDEX_TOOL_LIMIT, { listStale: true })
        const archived = archiveSummary(await readMemoryArchive(project.id))
        return archived ? `${live}\n\n${archived}` : live
      }
      if (action === 'search') {
        return searchMemory(memory, args?.query)
      }
      if (action === 'read') {
        const wanted = typeof args?.section === 'string' ? args.section.trim() : ''
        if (wanted) {
          const section = findMemorySection(memory, wanted)
          if (section) {
            return section.body ? `## ${section.title}\n\n${section.body}` : `## ${section.title}\n\n(empty section)`
          }
          // Compaction moves sections out of memory.md, not out of reach: the
          // archive is still searchable, and the answer says where it came from
          // so nobody mistakes archived history for live memory.
          const archived = findMemorySection(await readMemoryArchive(project.id), wanted)
          if (archived) {
            return `## ${archived.title}\n\n${archived.body}\n\n(Archived: compaction moved this section out of memory.md. It is no longer part of the memory workers see.)`
          }
          const titles = memorySections(memory).map((candidate) => candidate.title)
          throw new Error(
            `No memory section matches "${wanted}". ${titles.length ? `Sections: ${titles.join(' | ')}` : 'The memory has no "## " sections.'} Archived sections are searchable too (memory-archive.md).`,
          )
        }
        return memory.trim() ? memory.trim() : 'Shared memory is empty.'
      }
      const value = typeof args?.text === 'string' ? args.text.trim() : ''
      if (!value) throw new Error('text is required for append or write')
      if (action === 'write') {
        const written = await writeMemory(project.id, value)
        return `Replaced the shared memory of ${project.id} (${written.length} characters).${await afterMemoryWrite(project, written)}`
      }
      const next = memory.trim() ? `${memory.trimEnd()}\n\n${value}\n` : `${value}\n`
      const written = await writeMemory(project.id, next)
      return `Appended ${value.length} characters to the shared memory of ${project.id}.${await afterMemoryWrite(project, written)}`
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
