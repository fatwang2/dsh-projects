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
/**
 * Hard cap on the memory index injected into a worker prompt. The prompt has to
 * stay small no matter how large the memory grows, so the index is truncated
 * rather than the prompt.
 */
const MEMORY_INDEX_LIMIT = 2_000
/** The same index for the tool: the discovery path may be a little longer. */
const MEMORY_INDEX_TOOL_LIMIT = 8_000
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
/** Live dispatch controllers, so unloading the plugin stops its workers. */
const controllers = new Map()

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
 * Split the memory into its `## ` sections. Everything before the first heading
 * is the preamble and is reported separately, so a section lookup never has to
 * guess what to do with loose text.
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
    return { title: section.title, body, chars: body.length }
  })
}

function memoryPreamble(memory) {
  const text = String(memory ?? '')
  if (text.startsWith('## ')) return ''
  const at = text.indexOf('\n## ')
  return (at === -1 ? text : text.slice(0, at)).trim()
}

/**
 * The memory as an index: one line per section with its size, never the text.
 * This is what a worker prompt gets, so the prompt stays bounded no matter how
 * much history the project accumulates. `limit` is a hard cap on the returned
 * string; when it does not fit, whole sections are dropped and counted.
 */
function memoryIndex(memory, limit = MEMORY_INDEX_LIMIT) {
  const text = String(memory ?? '').trim()
  if (!text) return '(empty)'
  const sections = memorySections(text)
  if (sections.length === 0) {
    return `${text.length} characters, no "## " headings. Read it with projects_memory {action:"read"}.`
  }
  const header =
    `${sections.length} section(s), ${text.length} characters. ` +
    'Read one with projects_memory {action:"read", section:"<title>"} — do not assume you know what a section says.'
  const entries = []
  const preamble = memoryPreamble(text)
  if (preamble) entries.push(`- (preamble before the first heading) (${preamble.length} chars)`)
  for (const section of sections) entries.push(`- ${section.title} (${section.chars} chars)`)
  // Reserve room for the "…and N more" note so the note itself cannot push the
  // result past the cap.
  const room = Math.max(0, limit - header.length - 1 - 160)
  const shown = []
  let used = 0
  for (const entry of entries) {
    if (used + entry.length + 1 > room) break
    shown.push(entry)
    used += entry.length + 1
  }
  const omitted = entries.length - shown.length
  const lines = [header, ...shown]
  if (omitted > 0) lines.push(`- …and ${omitted} more section(s) not listed (index capped at ${limit} characters).`)
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
function memoryWarning({ length, truncated }) {
  const notes = []
  if (truncated) {
    notes.push(
      `WARNING: the memory hit the ${MAX_MEMORY}-character write ceiling and the tail was cut (only the tail: nothing before it was dropped).`,
    )
  }
  if (length > MEMORY_BUDGET) {
    notes.push(
      `WARNING: the shared memory is now ${length} characters, ${length - MEMORY_BUDGET} over the ${MEMORY_BUDGET}-character budget. ` +
        'Workers only receive an index, but the file should be compressed: read it with action "index", then replace it with a condensed version using action "write".',
    )
  }
  return notes.length ? ` ${notes.join(' ')}` : ''
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

async function removeTask(projectId, taskId) {
  const project = await readProject(projectId)
  const index = project.tasks.findIndex((candidate) => candidate.id === taskId)
  if (index < 0) throw httpError(404, 'task_not_found')
  project.tasks.splice(index, 1)
  project.updatedAt = Date.now()
  await writeProject(project)
  return project
}

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function workerPrompt(project, task, memory) {
  const lines = [
    `You are the worker for one task in the DSH project "${project.name}" (project_id: ${project.id}).`,
    'Do only this task, then report back. The coordinator keeps working while you run.',
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

async function routeRequest(ctx, method, path, req) {
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
    const project = await readProject(projectId)
    if (method === 'GET') {
      return { status: 200, body: { memory: await readMemory(project.id) } }
    }
    if (method === 'POST') {
      const body = await readJson(req)
      if (typeof body?.text !== 'string') throw httpError(400, 'text_required')
      await writeMemory(project.id, body.text)
      return { status: 200, body: { saved: true } }
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
      await removeTask(projectId, taskId)
      return { status: 200, body: { deleted: true } }
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
      const result = await routeRequest(ctx, method, path, req)
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

function formatProject(project, memory) {
  const lines = [
    `Project ${project.id} — ${project.name}`,
    `workspace: ${project.workspace || '(inherited)'}`,
    `autonomy: ${project.autonomy}, concurrency: ${project.concurrency}${project.archived ? ', ARCHIVED' : ''}`,
    `worker model: ${project.model || '(host default)'}${project.reasoningEffort ? `, effort: ${project.reasoningEffort}` : ''}${project.agentPreset ? `, preset: ${project.agentPreset}` : ''}`,
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
      'Read or write the shared memory of a project. The memory is a long append-only log, so read it by section: action "index" lists the section titles with their sizes, action "read" with a "section" returns just that section, and action "read" alone returns the whole file. Record durable findings, codebase knowledge and decisions here instead of repeating them in each task brief.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project id.' },
        action: {
          type: 'string',
          enum: ['index', 'read', 'append', 'write'],
          description: 'index (titles only), read (default; whole file, or one section with `section`), append a section, or replace all.',
        },
        section: {
          type: 'string',
          description: 'For action "read": a section title, or a distinctive part of one. Case-insensitive; exact, prefix and substring matches all work.',
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
      if (action === 'index') return memoryIndex(memory, MEMORY_INDEX_TOOL_LIMIT)
      if (action === 'read') {
        const wanted = typeof args?.section === 'string' ? args.section.trim() : ''
        if (wanted) {
          const section = findMemorySection(memory, wanted)
          if (!section) {
            const titles = memorySections(memory).map((candidate) => candidate.title)
            throw new Error(
              `No memory section matches "${wanted}". ${titles.length ? `Sections: ${titles.join(' | ')}` : 'The memory has no "## " sections.'}`,
            )
          }
          return section.body ? `## ${section.title}\n\n${section.body}` : `## ${section.title}\n\n(empty section)`
        }
        return memory.trim() ? memory.trim() : 'Shared memory is empty.'
      }
      const value = typeof args?.text === 'string' ? args.text.trim() : ''
      if (!value) throw new Error('text is required for append or write')
      if (action === 'write') {
        const written = await writeMemory(project.id, value)
        return `Replaced the shared memory of ${project.id} (${written.length} characters).${memoryWarning(written)}`
      }
      const next = memory.trim() ? `${memory.trimEnd()}\n\n${value}\n` : `${value}\n`
      const written = await writeMemory(project.id, next)
      return `Appended ${value.length} characters to the shared memory of ${project.id}.${memoryWarning(written)}`
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
