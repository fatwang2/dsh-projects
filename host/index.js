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
 * the shared memory and the task brief. The worker runs in the project
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
const MAX_MEMORY = 200_000
const MAX_TASKS = 200
const STATUSES = ['queued', 'running', 'review', 'done', 'failed', 'blocked']
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
  const task = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('t'),
    title: text(raw.title, 200) || 'Untitled task',
    brief: text(raw.brief, MAX_BRIEF),
    status: STATUSES.includes(raw.status) ? raw.status : 'queued',
    approved: raw.approved === true,
    output: text(raw.output, MAX_OUTPUT),
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
    concurrency: intIn(raw.concurrency, 1, 8, 2),
    archived: raw.archived === true,
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
  await writeFileAtomic(memoryFile(id), contents.slice(0, MAX_MEMORY))
}

function counts(tasks) {
  const result = { queued: 0, running: 0, review: 0, done: 0, failed: 0, blocked: 0 }
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
  if (patch?.concurrency !== undefined) project.concurrency = intIn(patch.concurrency, 1, 8, project.concurrency)
  if (patch?.archived !== undefined) project.archived = patch.archived === true
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  project.tasks.push(task)
  project.updatedAt = Date.now()
  await writeProject(project)
  return { project, task }
}

async function updateTask(projectId, taskId, patch) {
  const project = await readProject(projectId)
  const task = project.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw httpError(404, 'task_not_found')
  if (patch?.title !== undefined) task.title = text(patch.title, 200) || task.title
  if (patch?.brief !== undefined) task.brief = text(patch.brief, MAX_BRIEF)
  if (patch?.status !== undefined && STATUSES.includes(patch.status)) task.status = patch.status
  if (patch?.approved !== undefined) task.approved = patch.approved === true
  if (patch?.output !== undefined) task.output = text(patch.output, MAX_OUTPUT)
  task.updatedAt = Date.now()
  project.updatedAt = Date.now()
  await writeProject(project)
  return { project, task }
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
    memory.trim() || '(empty)',
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
  let started
  try {
    started = await subagents.startActivation({
      provider: 'spawn',
      label: `${project.name} · ${task.title}`.slice(0, 120),
      prompt: [{ type: 'text', text: workerPrompt(project, task, memory) }],
      parent: exec.agent,
      ...(cwd === undefined ? {} : { cwd }),
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
  return `Dispatched task ${task.id} to worker ${started.name} (session ${started.childId}). It runs in the background; its final message lands on the task when it settles.`
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

  // /projects/:id/tasks
  if (parts.length === 3 && parts[2] === 'tasks') {
    if (method !== 'POST') throw httpError(405, 'method_not_allowed')
    const body = await readJson(req)
    const { task } = await addTask(projectId, body)
    return { status: 201, body: { task } }
  }

  // /projects/:id/tasks/:taskId
  if (parts.length === 4 && parts[2] === 'tasks') {
    const taskId = parts[3]
    if (method === 'PATCH') {
      const body = await readJson(req)
      const { task } = await updateTask(projectId, taskId, body)
      return { status: 200, body: { task } }
    }
    if (method === 'DELETE') {
      await removeTask(projectId, taskId)
      return { status: 200, body: { deleted: true } }
    }
    throw httpError(405, 'method_not_allowed')
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
    '',
    '## Instructions',
    project.goal.trim() || '(none)',
    '',
    `## Tasks (${project.tasks.length})`,
  ]
  if (project.tasks.length === 0) lines.push('(none)')
  for (const task of project.tasks) {
    const worker = task.childName ? ` worker=${task.childName}` : ''
    lines.push(`- ${task.id} [${task.status}]${task.approved ? ' approved' : ''}${worker} ${task.title}`)
    if (task.output) lines.push(`    output: ${task.output.replace(/\n+/g, ' ').slice(0, 300)}`)
  }
  lines.push('', '## Shared memory', memory.trim() ? memory.trim().slice(0, MAX_OUTPUT) : '(empty)')
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
          return `- ${project.id}  "${project.name}"  autonomy=${project.autonomy} concurrency=${project.concurrency}${project.archived ? ' archived' : ''}  tasks: ${parts.join(', ') || 'none'}`
        })
        .join('\n')
    },
  })

  register({
    name: 'projects_create',
    description:
      'Create a project: one goal, its standing instructions, the workspace its workers run in, an autonomy mode and a worker concurrency limit. Returns the new project_id.',
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
      'Read one project: instructions, workspace, autonomy, every task with its status and output, and the shared memory. Use it before planning or reporting.',
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
          description: 'What the worker must do, where, and how to verify it. The worker also receives the project instructions and shared memory.',
        },
        approved: {
          type: 'boolean',
          description: 'Only for autonomy=manual: mark it approved when the user already approved it in this conversation.',
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
      'Update one task: its status, its recorded output, or its approval flag. Use status "done" after the user accepts a reviewed task, "blocked" when a human decision is needed, and "queued" to retry.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project id.' },
        task_id: { type: 'string', description: 'Task id from projects_get.' },
        status: {
          type: 'string',
          enum: ['queued', 'running', 'review', 'done', 'failed', 'blocked'],
          description: 'New status.',
        },
        output: { type: 'string', description: 'Summary to record on the task (kept to 4000 characters).' },
        approved: { type: 'boolean', description: 'Approval flag for autonomy=manual projects.' },
      },
      required: ['project_id', 'task_id'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const { task } = await updateTask(String(args?.project_id || ''), String(args?.task_id || ''), args)
      return `Task ${task.id} is now ${task.status}${task.approved ? ' (approved)' : ''}.`
    },
  })

  register({
    name: 'projects_memory',
    description:
      'Read or write the shared memory every worker of a project receives. Record durable findings, codebase knowledge and decisions here instead of repeating them in each task brief.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project id.' },
        action: { type: 'string', enum: ['read', 'append', 'write'], description: 'read (default), append a section, or replace all.' },
        text: { type: 'string', description: 'Text for append or write.' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const project = await readProject(String(args?.project_id || ''))
      const action = args?.action || 'read'
      if (action === 'read') {
        const memory = await readMemory(project.id)
        return memory.trim() ? memory.trim() : 'Shared memory is empty.'
      }
      const value = typeof args?.text === 'string' ? args.text.trim() : ''
      if (!value) throw new Error('text is required for append or write')
      if (action === 'write') {
        await writeMemory(project.id, value)
        return `Replaced the shared memory of ${project.id} (${value.length} characters).`
      }
      const current = await readMemory(project.id)
      const next = current.trim() ? `${current.trimEnd()}\n\n${value}\n` : `${value}\n`
      await writeMemory(project.id, next)
      return `Appended ${value.length} characters to the shared memory of ${project.id}.`
    },
  })

  register({
    name: 'projects_dispatch',
    description:
      'Dispatch one queued task to a worker subagent. The worker gets the project instructions, the shared memory and the task brief, runs in the project workspace, and reports its final message back onto the task. Returns immediately: the coordinator stays free.',
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
