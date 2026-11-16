/**
 * Host-half smoke test: load the plugin with a fake Cordis context, exercise
 * every tool against a temporary DSH_HOME, dispatch a fake worker, settle it,
 * and read the board back through the HTTP route handler.
 *
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

let home
let plugin
/** The project the tool tests build; later HTTP tests reuse it. */
let launchProjectId

const tools = new Map()
const routes = []
const listeners = new Map()
const activations = []

const fakeSubagents = {
  async startActivation(spec) {
    activations.push(spec)
    return { childId: 'child-session-1', name: 'agent-1', result: Promise.resolve({}), dispose: async () => {} }
  },
}

/**
 * Optional stand-ins for the `llm` and `agentPresets` services. They stay
 * undefined for every test that does not care, which is exactly the "profile
 * without an LLM adapter" case the model catalog must degrade from.
 */
let fakeLlm
let fakePresets

/**
 * Stand-in for the `workspaceRegistry` service. Archiving a session is a real
 * service call this process does not have, so the archive tests inject a
 * recorder instead: they assert *which* session the host asked to archive and
 * control whether the call succeeds, is refused, or fails. Reassigned per test
 * (`createRegistry()`) so call records never leak between cases.
 */
let fakeWorkspaceRegistry

function createRegistry() {
  const registry = {
    calls: [],
    archived: new Set(),
    failWith: null,
    async archiveSession(sessionId, options) {
      registry.calls.push({ sessionId, options })
      if (registry.failWith) throw registry.failWith
      registry.archived.add(sessionId)
    },
    async unarchiveSession(sessionId) {
      registry.calls.push({ sessionId, unarchive: true })
      registry.archived.delete(sessionId)
    },
  }
  return registry
}

function createContext() {
  return {
    effect(fn) {
      return fn()
    },
    get(name) {
      if (name === 'subagents') return fakeSubagents
      if (name === 'llm') return fakeLlm
      if (name === 'agentPresets') return fakePresets
      if (name === 'workspaceRegistry') return fakeWorkspaceRegistry
      return undefined
    },
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
}

function tool(name) {
  const definition = tools.get(name)
  assert.ok(definition, `tool ${name} is registered`)
  return definition
}

async function call(name, args, exec = { agent: { id: 'lead-session' } }) {
  return tool(name).execute(args, exec)
}

/** Minimal ServerResponse stand-in that records the JSON answer. */
function fakeResponse() {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      response.headers[key] = value
    },
    end(payload) {
      response.body = payload
    },
  }
  return response
}

async function request(method, path, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.destroy = () => {}
  const res = fakeResponse()
  const pending = routes[0].handler(req, res)
  // The handler attaches its body listeners synchronously; yield once so the
  // emits below can never race its first await.
  await Promise.resolve()
  if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  await pending
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-projects-test-'))
  process.env.DSH_HOME = home
  fakeWorkspaceRegistry = createRegistry()
  plugin = await import('../host/index.js')
  plugin.apply(createContext())
})

after(async () => {
  await rm(home, { recursive: true, force: true })
})

test('registers the route and every tool', () => {
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/projects-api')
  assert.deepEqual(
    [...tools.keys()].sort(),
    [
      'projects_add_task',
      'projects_create',
      'projects_dispatch',
      'projects_get',
      'projects_list',
      'projects_memory',
      'projects_update',
      'projects_update_task',
    ],
  )
})

test('creates, reads and updates a project through the tools', async () => {
  const created = await call('projects_create', {
    name: 'Launch site',
    goal: 'Ship the marketing site.',
    concurrency: 3,
  })
  assert.match(created, /Created project p-[0-9a-f]{8}/)
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]

  const list = await call('projects_list', {})
  assert.match(list, /Launch site/)
  assert.match(list, /autonomy=manual/)

  const added = await call('projects_add_task', {
    project_id: projectId,
    title: 'Write the hero copy',
    brief: 'Three variants, 40 words each.',
  })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  assert.match(added, /status queued/)

  const detail = await call('projects_get', { project_id: projectId })
  assert.match(detail, /Write the hero copy/)
  assert.match(detail, /Shared memory\n\(empty\)/)

  // The coordinator writes the status too: `resolved` is the human's verdict, so
  // the tool only relays it when the human has actually said so.
  const updated = await call('projects_update_task', {
    project_id: projectId,
    task_id: taskId,
    status: 'blocked',
    output: 'Three variants delivered.',
  })
  assert.match(updated, /is now blocked/)
  launchProjectId = projectId
})

test('shared memory append and write create topic files', async () => {
  const list = await call('projects_list', {})
  const projectId = list.match(/p-[0-9a-f]{8}/)[0]
  await call('projects_memory', {
    project_id: projectId,
    action: 'append',
    name: 'repo-conventions',
    description: 'Package manager and layout',
    text: 'Repo uses pnpm.',
  })
  await call('projects_memory', {
    project_id: projectId,
    action: 'append',
    name: 'repo-conventions',
    text: 'Copy lives in /content.',
  })
  const memory = await call('projects_memory', { project_id: projectId, action: 'read', name: 'repo-conventions' })
  assert.match(memory, /Repo uses pnpm\./)
  assert.match(memory, /Copy lives in \/content\./)
  await call('projects_memory', { project_id: projectId, action: 'write', name: 'repo-conventions', text: 'Only this.' })
  assert.equal(
    await call('projects_memory', { project_id: projectId, action: 'read', name: 'repo-conventions' }),
    'Only this.',
  )
})

test('manual autonomy blocks dispatch until the task is approved', async () => {
  const list = await call('projects_list', {})
  const projectId = list.match(/p-[0-9a-f]{8}/)[0]
  const added = await call('projects_add_task', { project_id: projectId, title: 'Build the pricing page' })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]

  const blocked = await call('projects_dispatch', { project_id: projectId, task_id: taskId })
  assert.match(blocked, /needs human approval/)
  assert.equal(activations.length, 0)

  await call('projects_update_task', { project_id: projectId, task_id: taskId, approved: true })
  const dispatched = await call('projects_dispatch', { project_id: projectId, task_id: taskId })
  assert.match(dispatched, /Dispatched task/)
  assert.equal(activations.length, 1)

  const spec = activations[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.parent.id, 'lead-session')
  assert.match(spec.label, /Launch site · Build the pricing page/)
  const prompt = spec.prompt[0].text
  assert.match(prompt, /Ship the marketing site\./)
  // The prompt carries an index of the shared memory, never the memory itself.
  assert.doesNotMatch(prompt, /Only this\./)
  assert.match(prompt, /## Shared project memory\n1 file\(s\), \d+ characters\./)
  assert.match(prompt, /· repo-conventions — Package manager and layout（\d+ chars，\d{4}-\d{2}-\d{2}）/)
  assert.match(prompt, /projects_memory \{project_id:"p-[0-9a-f]{8}", action:"read", name:"<name>"\}/)
  assert.match(prompt, /Build the pricing page/)
  assert.match(prompt, /projects_memory/)
})

test('settling a worker records its final message on the task', async () => {
  const list = await call('projects_list', {})
  const projectId = list.match(/p-[0-9a-f]{8}/)[0]
  const detailBefore = await call('projects_get', { project_id: projectId })
  assert.match(detailBefore, /\[running\]/)

  const settle = listeners.get('subagent/end')
  assert.ok(settle, 'subagent/end listener is registered')
  settle({
    id: 'child-session-1',
    parentSessionId: 'lead-session',
    provider: 'spawn',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Pricing page built; tests pass.' }],
  })
  await new Promise((resolve) => setTimeout(resolve, 100))

  const detail = await call('projects_get', { project_id: projectId })
  assert.match(detail, /\[review\]/)
  assert.match(detail, /Pricing page built; tests pass\./)
})

test('the HTTP route serves the board', async () => {
  const list = await request('GET', '/projects-api/projects')
  assert.equal(list.status, 200)
  assert.equal(list.body.projects.length, 1)
  assert.equal(list.body.projects[0].name, 'Launch site')
  assert.equal(list.body.projects[0].counts.review, 1)

  const projectId = list.body.projects[0].id
  const detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.project.tasks.length, 2)
  // The memory is a file list, never the whole text.
  assert.equal(detail.body.memory.files.length, 1)
  assert.equal(detail.body.memory.files[0].name, 'repo-conventions')
  assert.equal(detail.body.memory.files[0].description, 'Package manager and layout')
  assert.ok(detail.body.memory.files[0].size > 0)
  assert.match(detail.body.memory.files[0].modified, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(detail.body.memory.total, detail.body.memory.files[0].size)
  assert.equal(detail.body.memory.budget, 64_000)
  assert.doesNotMatch(JSON.stringify(detail.body.memory), /Only this\./)

  // The whole-memory route serves the generated index; the per-file route
  // serves one body for the page's preview.
  const memory = await request('GET', `/projects-api/projects/${projectId}/memory`)
  assert.equal(memory.status, 200)
  assert.match(memory.body.index, /1 file\(s\)/)
  assert.equal(memory.body.memory.files.length, 1)
  const file = await request('GET', `/projects-api/projects/${projectId}/memory/repo-conventions`)
  assert.equal(file.status, 200)
  assert.equal(file.body.text, 'Only this.')
  assert.equal(file.body.archived, false)
  const unknownFile = await request('GET', `/projects-api/projects/${projectId}/memory/nope`)
  assert.equal(unknownFile.status, 404)

  const missing = await request('GET', '/projects-api/projects/p-deadbeef')
  assert.equal(missing.status, 404)
})

// ---------------------------------------------------------------------------
// The page may only accept a task or take that acceptance back: PATCH is narrowed
// to `status`, and to exactly two of its values.

test('the page cannot write a status of its own choosing', async () => {
  const detail = await request('GET', `/projects-api/projects/${launchProjectId}`)
  assert.equal(detail.status, 200)
  const task = detail.body.project.tasks[0]
  assert.equal(task.status, 'blocked')
  const path = `/projects-api/projects/${launchProjectId}/tasks/${task.id}`

  // Every system status is out of reach, including the retired "done".
  for (const status of ['queued', 'running', 'failed', 'blocked', 'done', 'nonsense']) {
    const refused = await request('PATCH', path, { status })
    assert.equal(refused.status, 400, `status ${status} must be refused`)
    assert.match(refused.body.error, /only set status to "resolved" or "review"/)
  }

  // The retired boolean is refused too, and the error says what to send instead.
  const legacy = await request('PATCH', path, { resolved: true })
  assert.equal(legacy.status, 400)
  assert.match(legacy.body.error, /only "status" is writable/)
  assert.match(legacy.body.error, /send status "resolved" or "review"/)

  const output = await request('PATCH', path, { output: 'forged output' })
  assert.equal(output.status, 400)

  const approved = await request('PATCH', path, { approved: true })
  assert.equal(approved.status, 400)

  // A smuggled extra field poisons the whole patch instead of half-applying.
  const smuggled = await request('PATCH', path, { status: 'resolved', output: 'forged' })
  assert.equal(smuggled.status, 400)

  const empty = await request('PATCH', path, {})
  assert.equal(empty.status, 400)
  assert.match(empty.body.error, /status_required/)

  // Nothing leaked through.
  const after = await request('GET', `/projects-api/projects/${launchProjectId}`)
  const untouched = after.body.project.tasks[0]
  assert.equal(untouched.status, 'blocked')
  assert.equal(untouched.output, 'Three variants delivered.')
  assert.equal(untouched.approved, false)
})

test('the page accepts a task and the verdict is persisted as its status', async () => {
  const detail = await request('GET', `/projects-api/projects/${launchProjectId}`)
  const task = detail.body.project.tasks[0]
  const path = `/projects-api/projects/${launchProjectId}/tasks/${task.id}`

  const accepted = await request('PATCH', path, { status: 'resolved' })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.task.status, 'resolved')
  // One dimension: the row carries no second `resolved` field any more.
  assert.equal(accepted.body.task.resolved, undefined)

  // Written to disk, not just echoed back.
  const onDisk = JSON.parse(await readFile(join(home, 'projects', launchProjectId, 'project.json'), 'utf8'))
  assert.equal(onDisk.tasks[0].status, 'resolved')
  assert.equal(onDisk.tasks[0].resolved, undefined)

  // Un-accepting returns the task to review: the enum has no memory of what the
  // status was before the human accepted it.
  const back = await request('PATCH', path, { status: 'review' })
  assert.equal(back.status, 200)
  assert.equal(back.body.task.status, 'review')

  const again = await request('PATCH', path, { status: 'resolved' })
  assert.equal(again.body.task.status, 'resolved')
})

test('the create-task HTTP route is gone', async () => {
  const created = await request('POST', `/projects-api/projects/${launchProjectId}/tasks`, { title: 'Sneaky task' })
  assert.equal(created.status, 404)

  const detail = await request('GET', `/projects-api/projects/${launchProjectId}`)
  assert.equal(detail.body.project.tasks.length, 2)
})

test('the coordinator tool can relay the human verdict, and has no resolved boolean', async () => {
  const definition = tool('projects_update_task')
  assert.equal(definition.parameters.properties.resolved, undefined)
  assert.deepEqual(definition.parameters.properties.status.enum, [
    'queued',
    'running',
    'review',
    'failed',
    'blocked',
    'resolved',
  ])

  const detail = await request('GET', `/projects-api/projects/${launchProjectId}`)
  const task = detail.body.project.tasks[0]
  assert.equal(task.status, 'resolved')

  // A stale caller that still sends the retired boolean changes nothing: execute
  // only forwards the fields the schema declares.
  await call('projects_update_task', { project_id: launchProjectId, task_id: task.id, resolved: false })
  const after = await request('GET', `/projects-api/projects/${launchProjectId}`)
  assert.equal(after.body.project.tasks[0].status, 'resolved')

  // Status is the only dimension, so the tool relays both directions of the
  // human verdict: back to review, then resolved again.
  const back = await call('projects_update_task', {
    project_id: launchProjectId,
    task_id: task.id,
    status: 'review',
  })
  assert.match(back, /is now review/)
  const accepted = await call('projects_update_task', {
    project_id: launchProjectId,
    task_id: task.id,
    status: 'resolved',
  })
  assert.match(accepted, /is now resolved/)
})

test('reading a legacy project folds "done" and the resolved boolean into status resolved', async () => {
  const projectId = 'p-aaaaaaaa'
  const dir = join(home, 'projects', projectId)
  await mkdir(dir, { recursive: true })
  const legacy = {
    version: 1,
    id: projectId,
    name: 'Legacy board',
    goal: '',
    workspace: '',
    autonomy: 'manual',
    concurrency: 2,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    tasks: [
      {
        id: 't-00000001',
        title: 'Accepted before the change',
        brief: '',
        status: 'done',
        approved: true,
        output: 'Shipped.',
        createdAt: 1,
        updatedAt: 1,
      },
      { id: 't-00000002', title: 'Still queued', brief: '', status: 'queued', createdAt: 1, updatedAt: 1 },
      { id: 't-00000003', title: 'Unknown status', brief: '', status: 'nonsense', createdAt: 1, updatedAt: 1 },
      {
        id: 't-00000004',
        title: 'Accepted by the old boolean',
        brief: '',
        status: 'review',
        resolved: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  }
  await writeFile(join(dir, 'project.json'), `${JSON.stringify(legacy, null, 2)}\n`)

  const detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.status, 200)
  const [migrated, queued, bogus, booleanAccepted] = detail.body.project.tasks
  // Both legacy shapes land on the one status; the boolean is not carried over.
  assert.equal(migrated.status, 'resolved')
  assert.equal(migrated.approved, true)
  assert.equal(migrated.output, 'Shipped.')
  assert.equal(migrated.resolved, undefined)
  assert.equal(queued.status, 'queued')
  assert.equal(bogus.status, 'queued')
  assert.equal(booleanAccepted.status, 'resolved')
  assert.equal(booleanAccepted.resolved, undefined)

  // "done" is gone from the tally as well: accepted rows count as resolved and
  // never as review work waiting on the human.
  const list = await request('GET', '/projects-api/projects')
  const summary = list.body.projects.find((project) => project.id === projectId)
  assert.ok(summary, 'legacy project is listed')
  assert.equal(summary.counts.done, undefined)
  assert.equal(summary.counts.review, 0)
  assert.equal(summary.counts.resolved, 2)
  assert.equal(summary.counts.queued, 2)

  // The retired field survives only until the next write: rewriting the project
  // leaves no `resolved` key on disk.
  await call('projects_update_task', { project_id: projectId, task_id: 't-00000002', status: 'blocked' })
  const stored = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
  assert.deepEqual(stored.tasks.map((task) => task.status), ['resolved', 'blocked', 'queued', 'resolved'])
  assert.ok(stored.tasks.every((task) => !('resolved' in task)), 'the resolved boolean is gone from disk')
})

// ---------------------------------------------------------------------------
// The tally and the page's Threads groups share one definition of "outstanding":
// a task is in exactly one status bucket, and resolved work is not outstanding.

test('the tally puts every task in exactly one status bucket', async () => {
  const projectId = await newProject('Tally', { autonomy: 'auto' })
  const add = async (title) => {
    const added = await call('projects_add_task', { project_id: projectId, title })
    return added.match(/t-[0-9a-f]{8}/)[0]
  }
  await add('Still queued')
  const runningId = await add('Still running')
  const reviewId = await add('Waiting for review')
  const blockedId = await add('Needs a decision')
  await call('projects_update_task', { project_id: projectId, task_id: runningId, status: 'running' })
  await call('projects_update_task', { project_id: projectId, task_id: reviewId, status: 'review' })
  await call('projects_update_task', { project_id: projectId, task_id: blockedId, status: 'blocked' })

  // The human accepts the settled task and the blocked one. Status is the only
  // dimension, so accepting moves the task out of review/blocked entirely.
  for (const taskId of [reviewId, blockedId]) {
    const patch = await request('PATCH', `/projects-api/projects/${projectId}/tasks/${taskId}`, {
      status: 'resolved',
    })
    assert.equal(patch.status, 200)
    assert.equal(patch.body.task.status, 'resolved')
  }

  const list = await request('GET', '/projects-api/projects')
  const summary = list.body.projects.find((project) => project.id === projectId)
  assert.deepEqual(summary.counts, { queued: 1, running: 1, review: 0, failed: 0, blocked: 0, resolved: 2 })
  // Nothing is counted twice: the buckets still add up to the board size.
  assert.equal(Object.values(summary.counts).reduce((sum, value) => sum + value, 0), 4)

  // The coordinator's list prints the same numbers, and resolved is not added a
  // second time on top of the tally.
  const printed = await call('projects_list', {})
  const line = printed.split('\n').find((row) => row.includes(projectId))
  assert.match(line, /tasks: 1 queued, 1 running, 2 resolved$/)
  assert.doesNotMatch(line, /review|blocked/)

  // The detail view carries the tally too, so the coordinator reads the same split.
  const detail = await call('projects_get', { project_id: projectId })
  assert.match(detail, /## Tasks \(4\)\ncounts: 1 queued, 1 running, 2 resolved\n/)
  assert.doesNotMatch(detail, /counts: [^\n]*(review|blocked)/)
})

test('accepting a task is lossy: the status it came from is not recoverable', async () => {
  // One dimension means accepting a failed task overwrites `failed`. The worker
  // evidence (output) survives, but un-accepting returns the task to review, not
  // to failed — there is nowhere to remember the old status.
  const projectId = await newProject('Lossy accept', { autonomy: 'auto' })
  const added = await call('projects_add_task', { project_id: projectId, title: 'Crashed worker' })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  await call('projects_update_task', {
    project_id: projectId,
    task_id: taskId,
    status: 'failed',
    output: 'Worker died on step 3.',
  })
  const path = `/projects-api/projects/${projectId}/tasks/${taskId}`

  const accepted = await request('PATCH', path, { status: 'resolved' })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.task.status, 'resolved')
  assert.equal(accepted.body.task.output, 'Worker died on step 3.')

  const back = await request('PATCH', path, { status: 'review' })
  assert.equal(back.status, 200)
  assert.equal(back.body.task.status, 'review')
  assert.equal(back.body.task.output, 'Worker died on step 3.')
})

test('a task accepted while its worker runs keeps the verdict and still records the message', async () => {
  // The human may accept a task before its worker settles. Status becomes
  // `resolved`, so liveness can no longer be read off the status: the dispatch
  // guard and the concurrency ceiling must still see the live worker, and the
  // settle event must still land the final message.
  const projectId = 'p-bbbbbbbb'
  const dir = join(home, 'projects', projectId)
  await mkdir(dir, { recursive: true })
  const inFlight = {
    version: 1,
    id: projectId,
    name: 'Accepted in flight',
    goal: '',
    workspace: '',
    autonomy: 'auto',
    concurrency: 1,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    tasks: [
      {
        id: 't-00000001',
        title: 'Accepted before it settled',
        brief: '',
        status: 'resolved',
        childSessionId: 'child-session-in-flight',
        childName: 'agent-9',
        startedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  }
  await writeFile(join(dir, 'project.json'), `${JSON.stringify(inFlight, null, 2)}\n`)

  // The live worker is still occupying its lane, and it cannot be dispatched again.
  const added = await call('projects_add_task', { project_id: projectId, title: 'Second lane' })
  const secondId = added.match(/t-[0-9a-f]{8}/)[0]
  const refused = await call('projects_dispatch', { project_id: projectId, task_id: secondId })
  assert.match(refused, /Concurrency limit reached \(1\/1 workers running\)/)
  const again = await call('projects_dispatch', { project_id: projectId, task_id: 't-00000001' })
  assert.match(again, /already running as agent-9/)

  const settle = listeners.get('subagent/end')
  settle({
    id: 'child-session-in-flight',
    parentSessionId: 'lead-session',
    provider: 'spawn',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Finished after the human accepted.' }],
  })
  await new Promise((resolve) => setTimeout(resolve, 100))

  const detail = await request('GET', `/projects-api/projects/${projectId}`)
  const task = detail.body.project.tasks.find((candidate) => candidate.id === 't-00000001')
  // The human's verdict wins over the settle status...
  assert.equal(task.status, 'resolved')
  // ...but the worker's evidence is not lost.
  assert.equal(task.output, 'Finished after the human accepted.')
  assert.equal(task.stopReason, 'completed')
  assert.ok(task.finishedAt > 0)

  // The lane is free again now that the run has settled.
  const admitted = await call('projects_dispatch', { project_id: projectId, task_id: secondId })
  assert.match(admitted, /Dispatched task/)
})

// ---------------------------------------------------------------------------
// The manual-mode gate has its own narrow POST route; PATCH stays the accept door.

let gateProjectId
let gateTaskId

function approvePath(projectId, taskId) {
  return `/projects-api/projects/${projectId}/tasks/${taskId}/approve`
}

test('the approve route flips approved and persists it', async () => {
  const created = await call('projects_create', { name: 'Approve gate', goal: 'Check the gate.' })
  gateProjectId = created.match(/p-[0-9a-f]{8}/)[0]
  const added = await call('projects_add_task', { project_id: gateProjectId, title: 'Needs a human yes' })
  gateTaskId = added.match(/t-[0-9a-f]{8}/)[0]

  // The body is ignored on purpose: this route can only write `approved: true`,
  // so a stale bundle cannot smuggle `approved: false` or a status through it.
  const approved = await request('POST', approvePath(gateProjectId, gateTaskId), {
    approved: false,
    status: 'done',
  })
  assert.equal(approved.status, 200)
  assert.equal(approved.body.task.approved, true)
  assert.equal(approved.body.task.status, 'queued')

  // Written to disk, not just echoed back.
  const onDisk = JSON.parse(await readFile(join(home, 'projects', gateProjectId, 'project.json'), 'utf8'))
  assert.equal(onDisk.tasks[0].approved, true)
  assert.equal(onDisk.tasks[0].status, 'queued')
})

test('approving twice is idempotent', async () => {
  const again = await request('POST', approvePath(gateProjectId, gateTaskId))
  assert.equal(again.status, 200)
  assert.equal(again.body.task.approved, true)
  assert.equal(again.body.task.id, gateTaskId)
})

test('the approve route guards unknown ids and wrong methods', async () => {
  const unknownTask = await request('POST', approvePath(gateProjectId, 't-deadbeef'))
  assert.equal(unknownTask.status, 404)
  assert.match(unknownTask.body.error, /task_not_found/)

  const unknownProject = await request('POST', approvePath('p-deadbeef', 't-deadbeef'))
  assert.equal(unknownProject.status, 404)
  assert.match(unknownProject.body.error, /project_not_found/)

  // The gate is a POST door only; it is not a general task endpoint.
  const wrongMethod = await request('GET', approvePath(gateProjectId, gateTaskId))
  assert.equal(wrongMethod.status, 405)
})

test('the approve route refuses a task that is already running', async () => {
  const added = await call('projects_add_task', { project_id: gateProjectId, title: 'Already moving' })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  // The coordinator tool is the only writer of system status, so use it to build
  // the state instead of starting a real worker.
  await call('projects_update_task', { project_id: gateProjectId, task_id: taskId, status: 'running' })

  const refused = await request('POST', approvePath(gateProjectId, taskId))
  assert.equal(refused.status, 400)
  assert.match(refused.body.error, /task_already_running/)

  const detail = await request('GET', `/projects-api/projects/${gateProjectId}`)
  const task = detail.body.project.tasks.find((candidate) => candidate.id === taskId)
  assert.equal(task.approved, false)
})

test('the two write faces stay separate', async () => {
  const added = await call('projects_add_task', { project_id: gateProjectId, title: 'Second gate check' })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]

  // PATCH did not gain `approved`: the gate has its own door.
  const patched = await request('PATCH', `/projects-api/projects/${gateProjectId}/tasks/${taskId}`, {
    approved: true,
  })
  assert.equal(patched.status, 400)
  assert.match(patched.body.error, /only "status" is writable/)

  // ...and the gate did not become a way to create tasks.
  const created = await request('POST', `/projects-api/projects/${gateProjectId}/tasks`, { title: 'Sneaky task' })
  assert.equal(created.status, 404)

  const detail = await request('GET', `/projects-api/projects/${gateProjectId}`)
  assert.equal(detail.body.project.tasks.length, 3)
  assert.equal(detail.body.project.tasks.find((candidate) => candidate.id === taskId).approved, false)
})

// ---------------------------------------------------------------------------
// Worker model selection: a project default, a per-task override, and the
// catalog the page's picker reads.

let modelProjectId

test('a project default model round-trips through create, disk and the page', async () => {
  const created = await call('projects_create', {
    name: 'Model board',
    goal: 'Pin the worker route.',
    concurrency: 8,
    model: 'alpha/alpha-large',
    agentPreset: 'reviewer',
  })
  modelProjectId = created.match(/p-[0-9a-f]{8}/)[0]

  const onDisk = JSON.parse(await readFile(join(home, 'projects', modelProjectId, 'project.json'), 'utf8'))
  assert.equal(onDisk.model, 'alpha/alpha-large')
  assert.equal(onDisk.agentPreset, 'reviewer')

  const detail = await request('GET', `/projects-api/projects/${modelProjectId}`)
  assert.equal(detail.body.project.model, 'alpha/alpha-large')
  assert.equal(detail.body.project.agentPreset, 'reviewer')

  // The page retunes the project default through the ordinary project PATCH:
  // this is a project setting, not a task status, so it stays writable.
  const patched = await request('PATCH', `/projects-api/projects/${modelProjectId}`, { model: 'alpha/alpha-small' })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.project.model, 'alpha/alpha-small')

  // Clearing it means "host default", not "a route with an empty model".
  const cleared = await request('PATCH', `/projects-api/projects/${modelProjectId}`, { model: '' })
  assert.equal(cleared.body.project.model, '')

  await request('PATCH', `/projects-api/projects/${modelProjectId}`, { model: 'alpha/alpha-large' })
})

test('a task model overrides the project model at dispatch', async () => {
  const added = await call('projects_add_task', {
    project_id: modelProjectId,
    title: 'Use the small model',
    model: 'beta/beta-mini',
  })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  await call('projects_update_task', { project_id: modelProjectId, task_id: taskId, approved: true })

  const before = activations.length
  const dispatched = await call('projects_dispatch', { project_id: modelProjectId, task_id: taskId })
  assert.equal(activations.length, before + 1)
  assert.match(dispatched, /Dispatched task/)

  // The task override wins over the project default, and the stored route string
  // is split into the `agentOptions` pair the subagent service expects.
  const spec = activations.at(-1)
  assert.deepEqual(spec.agentOptions, { provider: 'beta', model: 'beta-mini' })
  assert.equal(spec.agentPreset, 'reviewer')
  assert.match(dispatched, /model=beta\/beta-mini/)
})

test('a task without its own model inherits the project default', async () => {
  const added = await call('projects_add_task', { project_id: modelProjectId, title: 'Inherit the project route' })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  await call('projects_update_task', { project_id: modelProjectId, task_id: taskId, approved: true })

  const before = activations.length
  await call('projects_dispatch', { project_id: modelProjectId, task_id: taskId })
  assert.equal(activations.length, before + 1)
  assert.deepEqual(activations.at(-1).agentOptions, { provider: 'alpha', model: 'alpha-large' })
})

test('dispatch omits the model fields entirely when nothing is selected', async () => {
  const created = await call('projects_create', { name: 'Plain board', goal: 'No route pinned.', concurrency: 4 })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]
  const added = await call('projects_add_task', { project_id: projectId, title: 'Host default route' })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  await call('projects_update_task', { project_id: projectId, task_id: taskId, approved: true })

  const before = activations.length
  await call('projects_dispatch', { project_id: projectId, task_id: taskId })
  assert.equal(activations.length, before + 1)

  // Not `agentOptions: undefined` and not `agentOptions: {}`: the key is absent,
  // so the child inherits the parent Agent's route untouched.
  const spec = activations.at(-1)
  assert.equal('agentOptions' in spec, false)
  assert.equal('agentPreset' in spec, false)
})

test('a non-string or blank model normalizes to empty instead of a bogus route', async () => {
  const created = await call('projects_create', { name: 'Normalize board', goal: '', model: 123 })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]
  const onDisk = JSON.parse(await readFile(join(home, 'projects', projectId, 'project.json'), 'utf8'))
  assert.equal(onDisk.model, '')

  const patched = await request('PATCH', `/projects-api/projects/${projectId}`, { model: 42 })
  assert.equal(patched.body.project.model, '')

  const added = await call('projects_add_task', { project_id: projectId, title: 'Bad model', model: 7 })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  const detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.body.project.tasks[0].model, '')

  // A bare id carries no provider, so the child keeps the parent's provider and
  // only the model half is overridden.
  await call('projects_update_task', {
    project_id: projectId,
    task_id: taskId,
    model: 'solo-model',
    approved: true,
  })
  const before = activations.length
  await call('projects_dispatch', { project_id: projectId, task_id: taskId })
  assert.equal(activations.length, before + 1)
  assert.deepEqual(activations.at(-1).agentOptions, { model: 'solo-model' })
})

test('the model catalog degrades to free text when the llm service is absent', async () => {
  fakeLlm = undefined
  fakePresets = undefined
  const answer = await request('GET', '/projects-api/models')
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body.models, [])
  assert.equal(answer.body.enumerable, false)
  assert.deepEqual(answer.body.presets, [])
  assert.equal(answer.body.presetsEnumerable, false)

  // Read-only: the catalog is not a write surface.
  const post = await request('POST', '/projects-api/models')
  assert.equal(post.status, 405)
})

test('the model catalog lists every advertised provider/model route', async () => {
  fakeLlm = {
    listProviders: () => [
      { id: 'gamma', name: 'Gamma' },
      { id: 'broken', name: 'Broken' },
    ],
    async listModels(provider) {
      // One unreachable catalog must not blank the whole picker.
      if (provider === 'broken') throw new Error('catalog unreachable')
      return [
        { provider: 'gamma', id: 'gamma-large', name: 'Gamma Large', description: 'Big one' },
        { provider: 'gamma', id: 'vendor/gamma-small', name: 'Gamma Small' },
      ]
    },
  }
  fakePresets = {
    async list() {
      return [
        { id: 'reviewer', name: 'Reviewer' },
        { id: 'damaged', broken: 'missing module' },
      ]
    },
  }

  const answer = await request('GET', '/projects-api/models')
  assert.equal(answer.status, 200)
  assert.equal(answer.body.enumerable, true)
  assert.deepEqual(
    answer.body.models.map((entry) => entry.id),
    ['gamma/gamma-large', 'gamma/vendor/gamma-small'],
  )
  assert.equal(answer.body.models[0].label, 'Gamma Large')
  assert.equal(answer.body.models[0].provider, 'gamma')
  assert.equal(answer.body.models[0].model, 'gamma-large')
  assert.equal(answer.body.models[0].description, 'Big one')
  // A model id that itself contains a slash survives the round trip; the picker
  // stores `id` verbatim and dispatch splits on the first slash only.
  assert.equal(answer.body.models[1].model, 'vendor/gamma-small')
  assert.deepEqual(answer.body.presets.map((entry) => entry.id), ['reviewer', 'damaged'])
  assert.equal(answer.body.presetsEnumerable, true)

  fakeLlm = undefined
  fakePresets = undefined
})

// ---------------------------------------------------------------------------
// Concurrency ceiling. The clamp lives in `normalizeProject` (read path) and
// `updateProject` (PATCH path); both share MAX_CONCURRENCY = 8, which matches
// the host subagent runtime's `maxActiveSubagents` pool default. The dispatch
// guard itself is unchanged — it still compares running workers to the stored
// value, so the only thing these tests pin is where the ceiling now sits.

test('concurrency 8 is accepted, persisted and served to the page', async () => {
  const created = await call('projects_create', {
    name: 'Eight wide',
    goal: 'Run eight workers at once.',
    concurrency: 8,
  })
  assert.match(created, /concurrency=8/)
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]

  const onDisk = JSON.parse(await readFile(join(home, 'projects', projectId, 'project.json'), 'utf8'))
  assert.equal(onDisk.concurrency, 8)

  const detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.project.concurrency, 8)

  // The tool schema advertises the same range the clamp enforces.
  assert.match(tool('projects_create').parameters.properties.concurrency.description, /1-8/)
})

test('concurrency above the ceiling is clamped to 8, not rejected', async () => {
  const created = await call('projects_create', {
    name: 'Eleven wide',
    goal: 'Clamp me to eight.',
    concurrency: 11,
  })
  assert.match(created, /concurrency=8/)
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]

  const onDisk = JSON.parse(await readFile(join(home, 'projects', projectId, 'project.json'), 'utf8'))
  assert.equal(onDisk.concurrency, 8)

  // The page's project PATCH runs through the same clamp, in both directions.
  const high = await request('PATCH', `/projects-api/projects/${projectId}`, { concurrency: 11 })
  assert.equal(high.status, 200)
  assert.equal(high.body.project.concurrency, 8)

  const low = await request('PATCH', `/projects-api/projects/${projectId}`, { concurrency: 0 })
  assert.equal(low.status, 200)
  assert.equal(low.body.project.concurrency, 1)

  const one = await request('PATCH', `/projects-api/projects/${projectId}`, { concurrency: 1 })
  assert.equal(one.body.project.concurrency, 1)
})

test('the dispatch guard admits 8 workers and refuses the ninth', async () => {
  const created = await call('projects_create', {
    name: 'Eight lanes',
    goal: 'Fill every slot.',
    concurrency: 8,
    autonomy: 'auto',
  })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]

  const taskIds = []
  for (let index = 0; index < 9; index += 1) {
    const added = await call('projects_add_task', { project_id: projectId, title: `Lane ${index + 1}` })
    taskIds.push(added.match(/t-[0-9a-f]{8}/)[0])
  }

  for (let index = 0; index < 8; index += 1) {
    const dispatched = await call('projects_dispatch', { project_id: projectId, task_id: taskIds[index] })
    assert.match(dispatched, /Dispatched task/, `worker ${index + 1} should be admitted`)
  }

  const refused = await call('projects_dispatch', { project_id: projectId, task_id: taskIds[8] })
  assert.match(refused, /Concurrency limit reached \(8\/8 workers running\)/)
})

// ---------------------------------------------------------------------------
// Worker reasoning effort. Efforts are provider-owned opaque ids (the LLM layer
// brands them `ReasoningEffortId` but has no global enum), so the host stores a
// free string, resolves the task → project chain at dispatch, and publishes the
// per-model legal values through GET /projects-api/models.

test('a project default reasoning effort round-trips through create, disk and the page', async () => {
  const created = await call('projects_create', {
    name: 'Effort board',
    goal: 'Pin the thinking level.',
    reasoningEffort: 'high',
  })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]

  const onDisk = JSON.parse(await readFile(join(home, 'projects', projectId, 'project.json'), 'utf8'))
  assert.equal(onDisk.reasoningEffort, 'high')

  const detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.body.project.reasoningEffort, 'high')

  // The page retunes it through the ordinary project PATCH: a project setting,
  // not a task status, so it stays writable.
  const patched = await request('PATCH', `/projects-api/projects/${projectId}`, { reasoningEffort: 'max' })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.project.reasoningEffort, 'max')

  // Clearing it means "provider default", not "an empty level".
  const cleared = await request('PATCH', `/projects-api/projects/${projectId}`, { reasoningEffort: '' })
  assert.equal(cleared.body.project.reasoningEffort, '')

  const restored = await request('PATCH', `/projects-api/projects/${projectId}`, { reasoningEffort: 'high' })
  assert.equal(restored.body.project.reasoningEffort, 'high')

  // The coordinator tools advertise the field too.
  assert.ok(tool('projects_create').parameters.properties.reasoningEffort)
  assert.ok(tool('projects_add_task').parameters.properties.reasoningEffort)
  assert.ok(tool('projects_update_task').parameters.properties.reasoningEffort)
  // ...and the agent preset stays supported on the host even though the page no
  // longer offers it.
  assert.ok(tool('projects_create').parameters.properties.agentPreset)
})

test('a task reasoning effort overrides the project effort at dispatch', async () => {
  const created = await call('projects_create', {
    name: 'Effort lanes',
    goal: 'Task override wins.',
    autonomy: 'auto',
    reasoningEffort: 'high',
  })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]

  const added = await call('projects_add_task', {
    project_id: projectId,
    title: 'Think hard',
    reasoningEffort: 'max',
  })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]

  const before = activations.length
  const dispatched = await call('projects_dispatch', { project_id: projectId, task_id: taskId })
  assert.equal(activations.length, before + 1)
  assert.match(dispatched, /Dispatched task/)
  assert.match(dispatched, /effort=max/)

  // No model is pinned on this project, so `agentOptions` carries the effort
  // alone — the child keeps the parent's route and only overrides the level.
  assert.deepEqual(activations.at(-1).agentOptions, { reasoningEffort: 'max' })

  // A task without its own effort inherits the project default.
  const inheriting = await call('projects_add_task', { project_id: projectId, title: 'Inherit the level' })
  const inheritingId = inheriting.match(/t-[0-9a-f]{8}/)[0]
  const before2 = activations.length
  await call('projects_dispatch', { project_id: projectId, task_id: inheritingId })
  assert.equal(activations.length, before2 + 1)
  assert.deepEqual(activations.at(-1).agentOptions, { reasoningEffort: 'high' })
})

test('an effort and a model travel together in one agentOptions object', async () => {
  const created = await call('projects_create', {
    name: 'Effort route',
    goal: 'Both halves.',
    autonomy: 'auto',
    model: 'alpha/alpha-large',
  })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]
  const added = await call('projects_add_task', {
    project_id: projectId,
    title: 'Route plus level',
    model: 'beta/beta-mini',
    reasoningEffort: 'low',
  })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]

  const before = activations.length
  await call('projects_dispatch', { project_id: projectId, task_id: taskId })
  assert.equal(activations.length, before + 1)
  assert.deepEqual(activations.at(-1).agentOptions, {
    provider: 'beta',
    model: 'beta-mini',
    reasoningEffort: 'low',
  })
})

test('dispatch omits reasoningEffort entirely when nothing is selected', async () => {
  const created = await call('projects_create', {
    name: 'Effort default',
    goal: 'No level pinned.',
    autonomy: 'auto',
    model: 'alpha/alpha-large',
  })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]
  const added = await call('projects_add_task', { project_id: projectId, title: 'Provider default level' })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]

  const before = activations.length
  await call('projects_dispatch', { project_id: projectId, task_id: taskId })
  assert.equal(activations.length, before + 1)
  const spec = activations.at(-1)
  // The route is still there; only the effort key is absent, so the provider
  // (not an empty string) decides the level.
  assert.deepEqual(spec.agentOptions, { provider: 'alpha', model: 'alpha-large' })
  assert.equal('reasoningEffort' in spec.agentOptions, false)
})

test('a non-string or blank reasoning effort normalizes to empty', async () => {
  const created = await call('projects_create', { name: 'Effort normalize', goal: '', reasoningEffort: 123 })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]
  const onDisk = JSON.parse(await readFile(join(home, 'projects', projectId, 'project.json'), 'utf8'))
  assert.equal(onDisk.reasoningEffort, '')

  const patched = await request('PATCH', `/projects-api/projects/${projectId}`, { reasoningEffort: 42 })
  assert.equal(patched.body.project.reasoningEffort, '')

  const added = await call('projects_add_task', { project_id: projectId, title: 'Bad effort', reasoningEffort: 7 })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  let detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.body.project.tasks[0].reasoningEffort, '')

  // The coordinator tool path normalizes the same way, and a blank value clears
  // an existing override instead of storing whitespace.
  await call('projects_update_task', { project_id: projectId, task_id: taskId, reasoningEffort: '  ' })
  detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.body.project.tasks[0].reasoningEffort, '')

  await call('projects_update_task', { project_id: projectId, task_id: taskId, reasoningEffort: 'medium' })
  detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.body.project.tasks[0].reasoningEffort, 'medium')
})

test('the model catalog publishes the reasoning efforts each route accepts', async () => {
  // Fresh provider ids: the catalog caches successful enumerations by provider
  // set for 60s, so reusing the earlier test's ids would serve its stale rows.
  fakeLlm = {
    listProviders: () => [
      { id: 'epsilon', name: 'Epsilon' },
      { id: 'zeta', name: 'Zeta' },
    ],
    async listModels(provider) {
      if (provider === 'zeta') throw new Error('catalog unreachable')
      return [
        { provider: 'epsilon', id: 'epsilon-large', name: 'Epsilon Large' },
        { provider: 'epsilon', id: 'epsilon-plain', name: 'Epsilon Plain' },
        { provider: 'epsilon', id: 'epsilon-broken', name: 'Epsilon Broken' },
      ]
    },
    async resolveModelInfo(provider, model) {
      if (model === 'epsilon-broken') throw new Error('metadata unavailable')
      if (model === 'epsilon-plain') return { provider, id: model, name: 'Epsilon Plain' }
      return {
        provider,
        id: model,
        name: 'Epsilon Large',
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off', description: 'No thinking' },
            { id: 'high', name: 'High' },
          ],
          defaultEffort: 'high',
        },
      }
    },
  }
  fakePresets = undefined

  const answer = await request('GET', '/projects-api/models')
  assert.equal(answer.status, 200)
  assert.equal(answer.body.enumerable, true)
  assert.deepEqual(
    answer.body.models.map((entry) => entry.id),
    ['epsilon/epsilon-large', 'epsilon/epsilon-plain', 'epsilon/epsilon-broken'],
  )

  // Efforts are provider-owned ids, passed through with the Host's own
  // `{ id, name, description? }` shape (what the page's pickers read).
  assert.deepEqual(answer.body.models[0].efforts, [
    { id: 'off', name: 'Off', description: 'No thinking' },
    { id: 'high', name: 'High' },
  ])
  assert.equal(answer.body.models[0].defaultEffort, 'high')

  // A route that reports no reasoning metadata still appears, with no choice.
  assert.deepEqual(answer.body.models[1].efforts, [])
  assert.equal('defaultEffort' in answer.body.models[1], false)

  // A route whose metadata cannot be resolved degrades the same way: the model
  // stays selectable, only its effort list is empty.
  assert.deepEqual(answer.body.models[2].efforts, [])
  assert.equal('defaultEffort' in answer.body.models[2], false)

  fakeLlm = undefined
  fakePresets = undefined
})

// ---------------------------------------------------------------------------
// The shared memory is one markdown file per topic. Workers get an index of it
// and pull the one file they need, so the prompt stays bounded.

function projectDirOf(projectId) {
  return join(home, 'projects', projectId)
}

async function readFileOr(file, fallback = '') {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return fallback
  }
}

/** The memory directory of a project created by these tests. */
function memoryDirOf(projectId) {
  return join(projectDirOf(projectId), 'memory')
}

/** The directory compaction moves whole files into. */
function archiveDirOf(projectId) {
  return join(memoryDirOf(projectId), 'archive')
}

/** One topic file's raw text ('' when it does not exist). */
async function memoryFileOf(projectId, name) {
  return readFileOr(join(memoryDirOf(projectId), `${name}.md`))
}

/** The generated index file on disk. */
async function memoryIndexOnDisk(projectId) {
  return readFileOr(join(memoryDirOf(projectId), 'MEMORY.md'))
}

/** The live topic file names (never MEMORY.md, never the archive directory). */
async function liveMemoryNames(projectId) {
  try {
    const entries = await readdir(memoryDirOf(projectId))
    return entries.filter((name) => name.endsWith('.md') && name !== 'MEMORY.md').sort()
  } catch {
    return []
  }
}

/** The archived file names, sorted. */
async function archiveNames(projectId) {
  try {
    return (await readdir(archiveDirOf(projectId))).sort()
  } catch {
    return []
  }
}

/**
 * Write topic files straight to disk, bypassing the tool. Used for fixtures that
 * are too large to build one tool call at a time (the index ladder), and to pin
 * the "a hand-written file is still a topic file" fallback.
 */
async function seedMemoryFiles(projectId, files) {
  const dir = memoryDirOf(projectId)
  await mkdir(dir, { recursive: true })
  for (const file of files) {
    const frontmatter = file.frontmatter === false
      ? ''
      : [
        '---',
        `name: ${file.name}`,
        `description: ${file.description ?? ''}`,
        `type: ${file.type || 'reference'}`,
        `modified: ${file.modified || new Date().toISOString()}`,
        '---',
        '',
      ].join('\n')
    await writeFile(join(dir, `${file.name}.md`), `${frontmatter}${file.body ?? ''}\n`)
  }
}

/** A project whose memory has two files, each with a description and a body marker. */
async function memoryProject(name) {
  const created = await call('projects_create', { name, goal: 'Ship it.', autonomy: 'auto' })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]
  await call('projects_memory', {
    project_id: projectId,
    action: 'write',
    name: 'alpha-decisions',
    description: 'Copy lives in /content.',
    text: 'Copy lives in /content.\nBODY-ALPHA-MARKER the copy lives in /content.',
  })
  await call('projects_memory', {
    project_id: projectId,
    action: 'write',
    name: 'beta-gotchas',
    description: 'pnpm only, no npm.',
    text: 'pnpm only, no npm.\nBODY-BETA-MARKER pnpm only, no npm.',
  })
  return projectId
}

test('projects_memory append creates a file with frontmatter and appends to it', async () => {
  const projectId = await newProject('Append action')
  const created = await call('projects_memory', {
    project_id: projectId,
    action: 'append',
    name: 'Deployment Notes',
    description: 'How deploys work',
    text: 'Deploys run from main.',
  })
  assert.match(created, /Appended 22 characters to memory file "deployment-notes"/)
  // The name is a slug, and the file carries the four frontmatter fields.
  const raw = await memoryFileOf(projectId, 'deployment-notes')
  assert.match(
    raw,
    /^---\nname: deployment-notes\ndescription: How deploys work\ntype: reference\nmodified: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n---\n\nDeploys run from main\.\n$/,
  )
  // `modified` is the write time, not the epoch.
  const modified = raw.match(/^modified: (.+)$/m)[1]
  assert.ok(Math.abs(Date.now() - Date.parse(modified)) < 60_000, `modified is the write time, got ${modified}`)

  const appended = await call('projects_memory', {
    project_id: projectId,
    action: 'append',
    name: 'deployment-notes',
    text: 'Rollback is a revert.',
  })
  assert.match(appended, /Appended 21 characters to memory file "deployment-notes" \(45 characters\)/)
  assert.equal(
    await call('projects_memory', { project_id: projectId, action: 'read', name: 'deployment-notes' }),
    'Deploys run from main.\n\nRollback is a revert.',
  )
  // A second append keeps the description the file was created with.
  assert.match(await memoryFileOf(projectId, 'deployment-notes'), /^description: How deploys work$/m)
})

test('projects_memory write replaces one file and keeps the others', async () => {
  const projectId = await memoryProject('Write action')
  const written = await call('projects_memory', {
    project_id: projectId,
    action: 'write',
    name: 'beta-gotchas',
    text: 'Only this.',
  })
  assert.match(written, /Replaced memory file "beta-gotchas" \(10 characters\)/)
  assert.equal(
    await call('projects_memory', { project_id: projectId, action: 'read', name: 'beta-gotchas' }),
    'Only this.',
  )
  // No description given: the existing one survives a rewrite.
  assert.match(await memoryFileOf(projectId, 'beta-gotchas'), /^description: pnpm only, no npm\.$/m)
  assert.match(
    await call('projects_memory', { project_id: projectId, action: 'read', name: 'alpha-decisions' }),
    /BODY-ALPHA-MARKER/,
  )
})

test('projects_memory index lists names, descriptions, sizes and dates without any body', async () => {
  const projectId = await memoryProject('Index action')
  const index = await call('projects_memory', { project_id: projectId, action: 'index' })
  assert.match(index, /2 file\(s\), \d+ characters\./)
  assert.match(index, /· alpha-decisions — Copy lives in \/content\.（\d+ chars，\d{4}-\d{2}-\d{2}）/)
  assert.match(index, /· beta-gotchas — pnpm only, no npm\.（\d+ chars，\d{4}-\d{2}-\d{2}）/)
  assert.doesNotMatch(index, /BODY-ALPHA-MARKER/)
  assert.doesNotMatch(index, /BODY-BETA-MARKER/)
  // The generated index file on disk is the same list.
  const onDisk = await memoryIndexOnDisk(projectId)
  assert.match(onDisk, /^# Shared memory index\n\n2 file\(s\)/)
  assert.match(onDisk, /· alpha-decisions — Copy lives in \/content\./)
})

test('projects_memory read with a name returns only that file', async () => {
  const projectId = await memoryProject('Name read')
  const exact = await call('projects_memory', { project_id: projectId, action: 'read', name: 'beta-gotchas' })
  assert.match(exact, /^pnpm only, no npm\.\nBODY-BETA-MARKER pnpm only, no npm\.$/)
  assert.doesNotMatch(exact, /BODY-ALPHA-MARKER/)

  // Matching is forgiving: case-insensitive, prefix and substring both work,
  // and a title copied from the old memory still finds the file.
  const prefix = await call('projects_memory', { project_id: projectId, action: 'read', name: 'alpha' })
  assert.match(prefix, /BODY-ALPHA-MARKER/)
  const substring = await call('projects_memory', { project_id: projectId, action: 'read', name: 'gotcha' })
  assert.match(substring, /BODY-BETA-MARKER/)
  const asTitle = await call('projects_memory', { project_id: projectId, action: 'read', name: 'Beta gotchas' })
  assert.match(asTitle, /BODY-BETA-MARKER/)
  // `section` is the deprecated alias for `name`.
  const alias = await call('projects_memory', { project_id: projectId, action: 'read', section: 'alpha' })
  assert.match(alias, /BODY-ALPHA-MARKER/)

  // An unknown name fails loudly and lists what does exist.
  await assert.rejects(
    () => call('projects_memory', { project_id: projectId, action: 'read', name: 'nope' }),
    /No memory file matches "nope"\. Files: alpha-decisions \| beta-gotchas/,
  )
})

test('projects_memory read without a name returns the index', async () => {
  const projectId = await memoryProject('Bare read')
  const index = await call('projects_memory', { project_id: projectId })
  assert.match(index, /2 file\(s\), \d+ characters\./)
  assert.match(index, /· alpha-decisions — /)
  assert.doesNotMatch(index, /BODY-ALPHA-MARKER/)
  // `action: 'read'` is the same thing, spelled out.
  assert.equal(await call('projects_memory', { project_id: projectId, action: 'read' }), index)
})

test('projects_memory delete removes one file and refreshes the index', async () => {
  const projectId = await memoryProject('Delete action')
  const deleted = await call('projects_memory', { project_id: projectId, action: 'delete', name: 'beta-gotchas' })
  assert.match(deleted, /Deleted memory file "beta-gotchas" \(\d+ characters\)\. The memory now has 1 file\(s\)/)
  await assert.rejects(
    () => call('projects_memory', { project_id: projectId, action: 'read', name: 'beta-gotchas' }),
    /No memory file matches "beta-gotchas"/,
  )
  const index = await call('projects_memory', { project_id: projectId, action: 'index' })
  assert.match(index, /1 file\(s\)/)
  assert.doesNotMatch(index, /beta-gotchas/)
  assert.doesNotMatch(await memoryIndexOnDisk(projectId), /beta-gotchas/)
  // Deleting a missing file is loud, and MEMORY.md is not a topic file.
  await assert.rejects(
    () => call('projects_memory', { project_id: projectId, action: 'delete', name: 'nope' }),
    /No memory file matches "nope"/,
  )
  await assert.rejects(
    () => call('projects_memory', { project_id: projectId, action: 'delete', name: 'MEMORY.md' }),
    /MEMORY\.md is the generated index/,
  )
})

test('a memory file name cannot escape the memory directory', async () => {
  const projectId = await newProject('Name safety')
  const projectBefore = await readFileOr(join(projectDirOf(projectId), 'project.json'))
  await call('projects_memory', { project_id: projectId, action: 'write', name: '../../project.json', text: 'x' })
  // The slug strips slashes and dots, so the write lands inside memory/.
  assert.match(await memoryFileOf(projectId, 'project-json'), /^---\nname: project-json/)
  assert.equal(await readFileOr(join(projectDirOf(projectId), 'project.json')), projectBefore)
  // A name with no usable characters is rejected instead of writing a file.
  await assert.rejects(
    () => call('projects_memory', { project_id: projectId, action: 'write', name: '!!!', text: 'x' }),
    /is not a valid memory file name/,
  )
})

test('the page can write and delete one memory file through the HTTP route', async () => {
  const projectId = await newProject('Page memory files')
  const created = await request('POST', `/projects-api/projects/${projectId}/memory`, {
    name: 'Deploy Notes',
    description: 'How deploys work',
    type: 'decision',
    text: 'Deploys run from main.',
  })
  assert.equal(created.status, 200)
  assert.equal(created.body.saved, true)
  assert.equal(created.body.name, 'deploy-notes')
  assert.equal(created.body.size, 22)

  // The `type` field round-trips through frontmatter.
  assert.match(await memoryFileOf(projectId, 'deploy-notes'), /^type: decision$/m)
  const read = await request('GET', `/projects-api/projects/${projectId}/memory/deploy-notes`)
  assert.equal(read.status, 200)
  assert.equal(read.body.type, 'decision')
  assert.equal(read.body.description, 'How deploys work')
  assert.equal(read.body.text, 'Deploys run from main.')

  // A write without a name is rejected instead of guessing a file.
  const nameless = await request('POST', `/projects-api/projects/${projectId}/memory`, { text: 'x' })
  assert.equal(nameless.status, 400)
  assert.match(nameless.body.error, /name is required/)

  // Delete removes exactly that file.
  const deleted = await request('DELETE', `/projects-api/projects/${projectId}/memory/deploy-notes`)
  assert.equal(deleted.status, 200)
  assert.equal(deleted.body.deleted, true)
  assert.deepEqual(await liveMemoryNames(projectId), [])
  const gone = await request('GET', `/projects-api/projects/${projectId}/memory/deploy-notes`)
  assert.equal(gone.status, 404)
})

test('a description is explicit frontmatter, and falls back to the first body line', async () => {
  const projectId = await newProject('Described memory')
  await call('projects_memory', {
    project_id: projectId,
    action: 'write',
    name: 'styled-section',
    description: '- **Bold** `code` and _plain_ text',
    text: '- **Bold** `code` and _plain_ text\nBODY-STYLED-HIDDEN',
  })
  await call('projects_memory', {
    project_id: projectId,
    action: 'write',
    name: 'derived-section',
    text: '#### Deep heading\nBODY-DEEP-HIDDEN',
  })
  await call('projects_memory', {
    project_id: projectId,
    action: 'write',
    name: 'truncated-section',
    description: 'L'.repeat(120),
    text: 'body',
  })
  // A hand-written file with no frontmatter at all is still a topic file.
  await seedMemoryFiles(projectId, [
    { name: 'hand-written', body: 'Plain first line.\nBODY-HAND-HIDDEN', frontmatter: false },
    { name: 'empty-file', body: '', frontmatter: false },
    { name: 'dated-file', description: 'Dated body.', modified: '2026-11-03T01:39:35.694Z', body: 'Dated body.' },
  ])
  const index = await call('projects_memory', { project_id: projectId, action: 'index' })
  // The explicit description is markdown-stripped like a derived one.
  assert.match(index, /· styled-section — Bold code and _plain_ text（\d+ chars，\d{4}-\d{2}-\d{2}）/)
  // No description: the first non-empty body line, heading hashes stripped.
  assert.match(index, /· derived-section — Deep heading（\d+ chars，\d{4}-\d{2}-\d{2}）/)
  // Longer than 80 characters: cut at 80 and marked with an ellipsis.
  assert.match(index, new RegExp(`· truncated-section — ${'L'.repeat(80)}…（\\d+ chars，`))
  // A file with no frontmatter: name from the file name, description from line 1.
  assert.match(index, /· hand-written — Plain first line\.（\d+ chars，\d{4}-\d{2}-\d{2}）/)
  // No body and no description: the name is the description.
  assert.match(index, /· empty-file — empty-file（0 chars，\d{4}-\d{2}-\d{2}）/)
  // `modified` from frontmatter is what the index shows.
  assert.match(index, /· dated-file — Dated body\.（11 chars，2026-11-03）/)
  assert.doesNotMatch(index, /BODY-STYLED-HIDDEN|BODY-DEEP-HIDDEN|BODY-HAND-HIDDEN/)
})

/** A project whose memory files are `[name, description, body]` triples. */
async function projectWithMemory(name, files) {
  const created = await call('projects_create', { name, goal: 'Ship it.', autonomy: 'auto' })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]
  for (const [file, description, body] of files) {
    await call('projects_memory', { project_id: projectId, action: 'write', name: file, description, text: body })
  }
  return projectId
}

/** `count` files whose description is exactly 80 characters. */
function describedFiles(count, tag = 'section') {
  return Array.from({ length: count }, (_, index) => ({
    name: `${tag}-${index}`,
    description: 'd'.repeat(80),
    body: `${'d'.repeat(80)}\nBODY-${tag}-${index}`,
  }))
}

/** The memory index a dispatched worker's prompt carries. */
async function promptMemoryIndex(projectId) {
  const added = await call('projects_add_task', { project_id: projectId, title: 'Read the memory' })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  await call('projects_dispatch', { project_id: projectId, task_id: taskId })
  const prompt = activations[activations.length - 1].prompt[0].text
  return prompt.split('## Shared project memory\n')[1].split('\n\nThe list above')[0]
}

test('projects_memory search matches names, descriptions and bodies without returning bodies', async () => {
  const projectId = await projectWithMemory('Searchable memory', [
    ['alpha-decisions', 'The copy lives in /content.', 'The copy lives in /content.\nBODY-ALPHA-SECRET'],
    ['beta-gotchas', 'pnpm only, no npm.', 'pnpm only, no npm.\nBODY-BETA-SECRET'],
    ['gamma-notes', 'Alpha is mentioned here too.', 'Alpha is mentioned here too.\nBODY-GAMMA-SECRET'],
    ['old-plan-superseded', 'Alpha plan that was replaced.', 'Alpha plan that was replaced.\nBODY-OLD-SECRET'],
  ])

  // A name match returns the file's name, description, size and date.
  const byName = await call('projects_memory', { project_id: projectId, action: 'search', query: 'beta' })
  assert.match(byName, /1 file\(s\) match "beta"/)
  assert.match(byName, /· beta-gotchas — pnpm only, no npm\.（\d+ chars，\d{4}-\d{2}-\d{2}）/)
  assert.doesNotMatch(byName, /BODY-BETA-SECRET/)

  // A description match works too.
  const byDescription = await call('projects_memory', { project_id: projectId, action: 'search', query: 'pnpm only' })
  assert.match(byDescription, /· beta-gotchas/)

  // A body match is case-insensitive and can return several files; the
  // superseded file contains the keyword too but is excluded.
  const byBody = await call('projects_memory', { project_id: projectId, action: 'search', query: 'ALPHA' })
  assert.match(byBody, /2 file\(s\) match "ALPHA"/)
  assert.match(byBody, /· alpha-decisions — The copy lives in \/content\./)
  assert.match(byBody, /· gamma-notes — Alpha is mentioned here too\./)
  assert.doesNotMatch(byBody, /BODY-ALPHA-SECRET|BODY-GAMMA-SECRET/)
  assert.doesNotMatch(byBody, /old-plan/)

  // No match says so and points at the index.
  const miss = await call('projects_memory', { project_id: projectId, action: 'search', query: 'zebra' })
  assert.match(miss, /No memory file matches "zebra"/)
  assert.match(miss, /action:"index"/)

  // A missing query is a loud error, not an empty result.
  await assert.rejects(
    () => call('projects_memory', { project_id: projectId, action: 'search' }),
    /query is required for action "search"/,
  )
})

test('search caps its result list and counts the files left out', async () => {
  const files = []
  for (let index = 0; index < 12; index += 1) {
    files.push([`match-${index}`, `keyword appears in file ${index}.`, `keyword appears in file ${index}.`])
  }
  const projectId = await projectWithMemory('Many matches', files)
  const result = await call('projects_memory', { project_id: projectId, action: 'search', query: 'keyword' })
  assert.match(result, /12 file\(s\) match "keyword", showing the first 10/)
  assert.match(result, /- …and 2 more file\(s\) match; narrow the query or use action:"index"\./)
  assert.equal((result.match(/^· /gm) || []).length, 10)
})

test('stale files leave the index and search but stay readable by name', async () => {
  const projectId = await projectWithMemory('Stale memory', [
    ['live-decision', 'Use pnpm.', 'Use pnpm.\nBODY-LIVE'],
    ['old-decision-superseded', 'Use npm.', 'Use npm.\nBODY-OLD'],
    ['ancient-notes-archived', 'Nothing to see.', 'Nothing to see.\nBODY-ANCIENT'],
  ])

  const index = await call('projects_memory', { project_id: projectId, action: 'index' })
  assert.match(index, /1 file\(s\), \d+ characters\./)
  assert.match(index, /· live-decision — Use pnpm\./)
  assert.doesNotMatch(index, /· old-decision/)
  assert.doesNotMatch(index, /· ancient-notes/)
  // They are still named once, names only, so a reader knows history exists.
  assert.match(
    index,
    /2 file\(s\) marked stale \(superseded\/archived; still readable by name\): old-decision-superseded \| ancient-notes-archived/,
  )

  const search = await call('projects_memory', { project_id: projectId, action: 'search', query: 'npm' })
  assert.match(search, /1 file\(s\) match "npm"/)
  assert.match(search, /· live-decision/)
  assert.doesNotMatch(search, /old-decision|ancient-notes/)

  // Read by name still works, marker included...
  const old = await call('projects_memory', { project_id: projectId, action: 'read', name: 'old-decision' })
  assert.match(old, /^Use npm\./)
  assert.match(old, /BODY-OLD/)
  // ...and the bare read is the index, so it carries no body at all.
  const bare = await call('projects_memory', { project_id: projectId })
  assert.doesNotMatch(bare, /BODY-OLD|BODY-ANCIENT/)

  // The worker prompt's index drops them entirely: workers act on current
  // knowledge, while the coordinator's index still names them above.
  const promptIndex = await promptMemoryIndex(projectId)
  assert.doesNotMatch(promptIndex, /old-decision|ancient-notes|marked stale/)
})

test('the index degrades in a fixed ladder when it exceeds its cap', async () => {
  // 10 files: the full format (name + description + size + date) fits 4000.
  const small = await newProject('Ladder small')
  await seedMemoryFiles(small, describedFiles(10))
  const smallIndex = await promptMemoryIndex(small)
  assert.match(smallIndex, /· section-0 — d{80}（\d+ chars，\d{4}-\d{2}-\d{2}）/)
  assert.doesNotMatch(smallIndex, /Descriptions omitted|Titles only|truncated/)

  // 40 files: descriptions no longer fit, sizes still do.
  const medium = await newProject('Ladder medium')
  await seedMemoryFiles(medium, describedFiles(40))
  const mediumIndex = await promptMemoryIndex(medium)
  assert.match(mediumIndex, /Descriptions omitted to fit the 4000-character index cap\./)
  assert.match(mediumIndex, /· section-0（\d+ chars，\d{4}-\d{2}-\d{2}）/)
  assert.doesNotMatch(mediumIndex, /· section-0 —/)
  assert.ok(mediumIndex.length <= 4000, `prompt index is capped, got ${mediumIndex.length}`)

  // 200 files: only names fit 4000; the tool's 8000-character index keeps the
  // sizes, which is the same ladder at a different threshold.
  const large = await newProject('Ladder large')
  await seedMemoryFiles(large, describedFiles(200))
  const largeIndex = await promptMemoryIndex(large)
  assert.match(largeIndex, /Titles only \(descriptions and sizes omitted\) to fit the 4000-character index cap\./)
  assert.match(largeIndex, /· section-0\n/)
  assert.doesNotMatch(largeIndex, /· section-0（/)
  assert.ok(largeIndex.length <= 4000, `prompt index is capped, got ${largeIndex.length}`)
  const largeToolIndex = await call('projects_memory', { project_id: large, action: 'index' })
  assert.match(largeToolIndex, /Descriptions omitted to fit the 8000-character index cap\./)
  assert.match(largeToolIndex, /· section-0（\d+ chars，\d{4}-\d{2}-\d{2}）/)
  assert.ok(largeToolIndex.length <= 8000, `tool index is capped, got ${largeToolIndex.length}`)

  // 400 files: even names do not fit, so the list is truncated and counted.
  const huge = await newProject('Ladder huge')
  await seedMemoryFiles(huge, describedFiles(400))
  const hugeIndex = await promptMemoryIndex(huge)
  assert.match(hugeIndex, /truncated to fit the 4000-character index cap/)
  assert.match(hugeIndex, /- …and \d+ more file\(s\) not listed \(index capped at 4000 characters\)\./)
  assert.ok(hugeIndex.length <= 4000, `prompt index is capped, got ${hugeIndex.length}`)
  assert.doesNotMatch(hugeIndex, /d{80}/)
})

test('the dispatch index keeps descriptions for a memory shaped like this project\'s', async () => {
  // Regression: this project's real memory (long Chinese names, 80-character
  // descriptions) overflowed the old 2000-character prompt cap and degraded to
  // L2 — names and sizes but no descriptions, which is the one thing the index
  // exists to provide. The cap is 4000, so this shape stays L1.
  const files = []
  for (let index = 1; index <= 16; index += 1) {
    files.push({
      name: `host-第-${index}-个很长的中文标题-2026-11-16-agent-${index}`,
      description: '描'.repeat(80),
      modified: '2026-11-16T00:00:00.000Z',
      body: `${'描'.repeat(80)}\nBODY-HIDDEN-${index}`,
    })
  }
  const projectId = await newProject('Real-shaped memory')
  await seedMemoryFiles(projectId, files)
  const index = await promptMemoryIndex(projectId)
  // The fixture really does reproduce the old overflow, and the new cap holds.
  assert.ok(index.length > 2000, `fixture must exceed the old cap, got ${index.length}`)
  assert.ok(index.length <= 4000, `prompt index is capped, got ${index.length}`)
  assert.match(index, /16 file\(s\)/)
  assert.doesNotMatch(index, /Descriptions omitted|Titles only|truncated/)
  // Every entry carries its description, size and date.
  assert.equal((index.match(/^· .+ — .+（\d+ chars，2026-11-16）$/gm) || []).length, 16)
  assert.doesNotMatch(index, /BODY-HIDDEN-/)
})

test('the tool index is capped at 8000 characters too', async () => {
  // 900 files with 80-character descriptions: the full, no-description and
  // name-only formats all overflow 8000, so the tool's index truncates too.
  const projectId = await newProject('Tool cap', { memoryBudget: 200_000 })
  await seedMemoryFiles(projectId, describedFiles(900))
  const index = await call('projects_memory', { project_id: projectId, action: 'index' })
  assert.ok(index.length <= 8000, `tool index is capped, got ${index.length}`)
  assert.match(index, /truncated to fit the 8000-character index cap/)
  assert.match(index, /- …and \d+ more file\(s\) not listed \(index capped at 8000 characters\)\./)
  assert.doesNotMatch(index, /d{80}/)
})

test('projects_get returns the memory index, not the memory body', async () => {
  const projectId = await memoryProject('Indexed get')
  const detail = await call('projects_get', { project_id: projectId })
  assert.match(detail, /## Shared memory\n2 file\(s\)/)
  assert.match(detail, /· alpha-decisions — Copy lives in \/content\.（\d+ chars，\d{4}-\d{2}-\d{2}）/)
  assert.doesNotMatch(detail, /BODY-ALPHA-MARKER/)
})

test('appending past the memory budget warns instead of truncating silently', async () => {
  const projectId = await newProject('Fat memory')
  await call('projects_memory', {
    project_id: projectId,
    action: 'write',
    name: 'start',
    description: 'Start.',
    text: 'small.',
  })

  const big = 'y'.repeat(65_000)
  const appended = await call('projects_memory', {
    project_id: projectId,
    action: 'append',
    name: 'bulk',
    description: 'Bulk.',
    text: big,
  })
  assert.match(appended, /Appended 65000 characters to memory file "bulk"/)
  assert.match(appended, /WARNING: the shared memory is now \d+ characters, \d+ over the 64000-character budget/)
  assert.doesNotMatch(appended, /hit the 200000-character write ceiling/)
  // Over budget with two files: auto-compaction moves the older one out whole.
  assert.match(
    appended,
    /Auto-compacted the shared memory: \d+ → \d+ characters \(1 file\(s\) moved to memory\/archive\/\)/,
  )
  assert.deepEqual(await archiveNames(projectId), ['start.md'])

  // Nothing was dropped: the append is on disk in full.
  const whole = await call('projects_memory', { project_id: projectId, action: 'read', name: 'bulk' })
  assert.equal(whole.length, 65_000, `memory kept its bytes, got ${whole.length}`)
})

test('a write past the hard ceiling is reported, not swallowed', async () => {
  const projectId = await newProject('Ceiling memory')
  const written = await call('projects_memory', {
    project_id: projectId,
    action: 'write',
    name: 'huge',
    text: 'z'.repeat(200_001),
  })
  assert.match(written, /hit the 200000-character write ceiling and the tail was cut/)
  assert.equal((await call('projects_memory', { project_id: projectId, action: 'read', name: 'huge' })).length, 200_000)
})

test('a legacy memory.md is migrated to one file per section', async () => {
  const projectId = await newProject('Legacy memory')
  const legacy = [
    'Loose preamble line one.',
    'Loose preamble line two.',
    '',
    '## Alpha decisions (2026-11-03)',
    'Copy lives in /content.',
    'BODY-ALPHA',
    '',
    '## Beta gotchas (2026-11-04, agent-2)',
    'pnpm only, no npm.',
    'BODY-BETA',
    '',
    '## Gamma notes',
    'No date in this title.',
    'BODY-GAMMA',
    '',
  ].join('\n')
  const legacyArchive = '## Compaction 2026-11-01T00:00:00.000Z — 100 → 50 characters, budget 4000\nMoved 1 section(s): Old\n\n## Old thing\n\nold body\n'
  await writeFile(join(projectDirOf(projectId), 'memory.md'), legacy)
  await writeFile(join(projectDirOf(projectId), 'memory-archive.md'), legacyArchive)

  const index = await call('projects_memory', { project_id: projectId, action: 'index' })
  // One file per `## ` section plus the preamble, named by slug, described by
  // the first body line, dated by the date in the title.
  assert.match(index, /4 file\(s\), \d+ characters\./)
  assert.match(index, /· alpha-decisions-2026-11-03 — Copy lives in \/content\.（\d+ chars，2026-11-03）/)
  assert.match(index, /· beta-gotchas-2026-11-04-agent-2 — pnpm only, no npm\.（\d+ chars，2026-11-04）/)
  assert.match(index, /· gamma-notes — No date in this title\./)
  assert.match(index, /· preamble — Loose preamble line one\./)
  // The legacy archive moved into memory/archive/ verbatim.
  assert.match(index, /1 archived file\(s\) in memory\/archive\//)
  assert.equal(await readFileOr(join(archiveDirOf(projectId), 'legacy-memory-archive.md')), legacyArchive)

  // Content survived: the title is the body's first line, the body is verbatim.
  const alpha = await call('projects_memory', { project_id: projectId, action: 'read', name: 'alpha-decisions-2026-11-03' })
  assert.match(alpha, /^# Alpha decisions \(2026-11-03\)\n\nCopy lives in \/content\.\nBODY-ALPHA$/)
  const gamma = await call('projects_memory', { project_id: projectId, action: 'read', name: 'gamma-notes' })
  assert.match(gamma, /^# Gamma notes\n\nNo date in this title\.\nBODY-GAMMA$/)

  // The legacy file is backed up, not deleted, and the originals are gone.
  assert.equal(await readFileOr(join(projectDirOf(projectId), 'memory.bak.md')), legacy)
  assert.equal(await readFileOr(join(projectDirOf(projectId), 'memory.md')), '')
  assert.equal(await readFileOr(join(projectDirOf(projectId), 'memory-archive.md')), '')

  // Idempotent: a second read neither duplicates files nor re-migrates.
  const again = await call('projects_memory', { project_id: projectId, action: 'index' })
  assert.equal(again, index)
  assert.deepEqual((await readdir(memoryDirOf(projectId))).sort(), [
    'MEMORY.md',
    'alpha-decisions-2026-11-03.md',
    'archive',
    'beta-gotchas-2026-11-04-agent-2.md',
    'gamma-notes.md',
    'preamble.md',
  ])
  // The generated index file lists the same files.
  assert.match(await memoryIndexOnDisk(projectId), /4 file\(s\)/)
})

// ---------------------------------------------------------------------------
// Worker output language
//
// The prompt was English-only, so a Chinese brief still came back in English and
// that English showed up as the thread subtitle and the embedded conversation.
// The fix is a hard rule near the top of the prompt, plus a concrete directive
// derived from the language the human actually wrote in.

/**
 * Dispatch one task in a fresh auto project and return the prompt its worker
 * received. Every call gets its own project so the concurrency guard and the
 * running-task bookkeeping of earlier tests cannot interfere.
 */
async function promptFor({ goal, brief, title = 'Task', name = 'Language probe' }) {
  const created = await call('projects_create', { name, goal, autonomy: 'auto' })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]
  const added = await call('projects_add_task', {
    project_id: projectId,
    title,
    ...(brief === undefined ? {} : { brief }),
  })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  const dispatched = await call('projects_dispatch', { project_id: projectId, task_id: taskId })
  assert.match(dispatched, /Dispatched task/)
  return activations[activations.length - 1].prompt[0].text
}

/** The language section of a prompt, cut at its closing blank line. */
function languageBlock(prompt) {
  const start = prompt.indexOf('## Language (hard rule)')
  assert.ok(start >= 0, 'the prompt states the language rule')
  return prompt.slice(start, prompt.indexOf('\n\n', start))
}

test('a migration can be rolled back from memory.bak.md', async () => {
  const projectId = await newProject('Rollback')
  const legacy = '## Alpha (2026-11-03)\n\nCopy lives in /content.\n'
  await writeFile(join(projectDirOf(projectId), 'memory.md'), legacy)
  await call('projects_memory', { project_id: projectId, action: 'index' })
  assert.equal(await readFileOr(join(projectDirOf(projectId), 'memory.bak.md')), legacy)

  // A human rollback: restore the legacy file, drop the per-file memory.
  await writeFile(join(projectDirOf(projectId), 'memory.md'), legacy)
  await rm(memoryDirOf(projectId), { recursive: true, force: true })

  // The next read migrates again, from the restored file, to the same content.
  const index = await call('projects_memory', { project_id: projectId, action: 'index' })
  assert.match(index, /1 file\(s\)/)
  assert.equal(
    await call('projects_memory', { project_id: projectId, action: 'read', name: 'alpha-2026-11-03' }),
    '# Alpha (2026-11-03)\n\nCopy lives in /content.',
  )
  assert.equal(await readFileOr(join(projectDirOf(projectId), 'memory.bak.md')), legacy)
})

test('migration never writes the reserved index name or an empty name', async () => {
  const projectId = await newProject('Reserved names')
  await writeFile(join(projectDirOf(projectId), 'memory.md'), [
    '## Memory',
    'A section whose slug is the reserved index name.',
    'BODY-RESERVED',
    '',
    '## ！！！',
    'A section whose slug is empty.',
    'BODY-PUNCT',
    '',
  ].join('\n'))
  const index = await call('projects_memory', { project_id: projectId, action: 'index' })
  assert.match(index, /2 file\(s\)/)
  assert.match(index, /· memory-topic — A section whose slug is the reserved index name\./)
  assert.match(index, /· memory-topic-2 — A section whose slug is empty\./)
  assert.deepEqual(await liveMemoryNames(projectId), ['memory-topic-2.md', 'memory-topic.md'])
  // Both bodies survived the rename.
  assert.match(await call('projects_memory', { project_id: projectId, action: 'read', name: 'memory-topic' }), /BODY-RESERVED/)
  assert.match(await call('projects_memory', { project_id: projectId, action: 'read', name: 'memory-topic-2' }), /BODY-PUNCT/)
})

test('the worker prompt names the language to answer in', async () => {
  const zh = await promptFor({ name: '中文项目', goal: '发布营销站点。', brief: '写三个标题变体。' })
  const zhBlock = languageBlock(zh)
  assert.match(zhBlock, /Write your entire reply in Chinese \(中文\)/)
  // The rule must not be a suggestion, and it must name what cannot override it.
  assert.match(zhBlock, /This prompt being in English is not a reason to answer in English/)
  assert.match(zhBlock, /tool names, code, file paths or the shared project memory/)
  assert.match(zhBlock, /follow the language of the project instructions instead/)
  assert.match(zhBlock, /if the two disagree, follow the brief/)

  const en = await promptFor({ name: 'English project', goal: 'Ship the marketing site.', brief: 'Write three headline variants.' })
  const enBlock = languageBlock(en)
  assert.match(enBlock, /Write your entire reply in English/)
  assert.doesNotMatch(enBlock, /Chinese/)

  // "Near the top" is part of the contract: the model settles its answer
  // language from the first screen, and everything below is English.
  assert.ok(zh.indexOf('## Language (hard rule)') > zh.indexOf('Do only this task'))
  assert.ok(zh.indexOf('## Language (hard rule)') < zh.indexOf('## Project instructions'))
  assert.ok(zh.indexOf('## Language (hard rule)') < zh.indexOf('## Your task'))
})

test('an empty brief falls back to the project instructions language', async () => {
  const zh = await promptFor({ name: '中文目标', goal: '把这个仓库的文档补齐。' })
  assert.match(languageBlock(zh), /Write your entire reply in Chinese \(中文\)/)

  const en = await promptFor({ name: 'English goal', goal: 'Fill in the missing docs.' })
  assert.match(languageBlock(en), /Write your entire reply in English/)

  // Neither language is present: state the rule without guessing one.
  const neither = await promptFor({ name: 'Numbers', goal: '1234', brief: '5678' })
  const block = languageBlock(neither)
  assert.match(block, /Write your entire reply in the language the human wrote the task brief in/)
  assert.doesNotMatch(block, /Write your entire reply in (Chinese|English)/)
})

test('language detection follows the human, not the Latin identifiers in a brief', async () => {
  // A real Chinese brief is full of Latin identifiers; counting scripts and
  // taking the majority would call this English.
  const mixed = await promptFor({
    name: '混合项目',
    goal: '修复 workerPrompt 的硬编码英文。',
    brief: '改 host/index.js 的 workerPrompt()，让 task.output 跟随 brief 语言。不要碰 client/index.js。',
  })
  assert.match(languageBlock(mixed), /Write your entire reply in Chinese \(中文\)/)

  // Japanese also uses Han, so guessing Chinese there would be worse than
  // saying nothing: no concrete directive, the general rule still applies.
  const ja = await promptFor({
    name: '日本語プロジェクト',
    goal: 'マーケティングサイトを公開する。',
    brief: '見出しのバリエーションを三つ書いてください。',
  })
  const jaBlock = languageBlock(ja)
  assert.doesNotMatch(jaBlock, /Write your entire reply in (Chinese|English)/)
  assert.match(jaBlock, /Write your entire reply in the language the human wrote the task brief in/)

  // The Host has no locale service to consult, so the plugin must not depend on
  // one. `locale` is provided by the Client half of dsh-client-locale only.
  assert.deepEqual(plugin.inject, ['webServer', 'tools'])
})

// ---------------------------------------------------------------------------
// Automatic memory compaction
//
// The memory only grows. Once it crosses the project's budget the host moves its
// oldest whole files into `memory/archive/` and keeps the rest — deterministic,
// no LLM, nothing summarised away, and never a split file. These tests drive
// that through both write paths (the tool and the page's HTTP route) and pin the
// safety rails: a rollback when the archive cannot be written, and single-flight
// per project.

async function storedProject(projectId) {
  return JSON.parse(await readFileOr(join(projectDirOf(projectId), 'project.json'), '{}'))
}

/** A memory of `count` files of roughly `size` characters each. */
function memoryFileFixtures(count, size, tag = 's') {
  const files = []
  for (let index = 1; index <= count; index += 1) {
    files.push({
      name: `${tag}${index}-durable-fact`,
      description: `Durable fact ${index}`,
      body: 'x'.repeat(size),
    })
  }
  return files
}

async function writeMemoryFixtures(projectId, files) {
  for (const file of files) {
    await call('projects_memory', {
      project_id: projectId,
      action: 'write',
      name: file.name,
      description: file.description,
      text: file.body,
    })
  }
}

async function newProject(name, extra = {}) {
  const created = await call('projects_create', { name, autonomy: 'auto', ...extra })
  return created.match(/p-[0-9a-f]{8}/)[0]
}

test('a memory under its budget is not compacted', async () => {
  const projectId = await newProject('Small memory', { memoryBudget: 4_000 })
  const written = await call('projects_memory', {
    project_id: projectId,
    action: 'write',
    name: 's1-durable-fact',
    description: 'Durable fact 1',
    text: 'x'.repeat(900),
  })
  const second = await call('projects_memory', {
    project_id: projectId,
    action: 'write',
    name: 's2-durable-fact',
    description: 'Durable fact 2',
    text: 'x'.repeat(900),
  })
  assert.doesNotMatch(written, /Auto-compacted/)
  assert.doesNotMatch(second, /Auto-compacted/)
  assert.deepEqual(await archiveNames(projectId), [])
  assert.equal((await storedProject(projectId)).lastCompaction, undefined)
  // And the ordinary budget warning is gone too: nothing is over budget.
  assert.doesNotMatch(second, /WARNING/)
})

test('a memory over its budget archives its oldest files automatically', async () => {
  // autoCompact off while the fixture is built, so the six files all exist before
  // the one write that crosses the budget; that write must archive the four
  // oldest, whole.
  const projectId = await newProject('Fat memory', { memoryBudget: 4_000, autoCompact: false })
  await writeMemoryFixtures(projectId, memoryFileFixtures(5, 1_000))
  assert.equal((await liveMemoryNames(projectId)).length, 5)
  await call('projects_update', { project_id: projectId, autoCompact: true })

  const written = await call('projects_memory', {
    project_id: projectId,
    action: 'write',
    name: 's6-durable-fact',
    description: 'Durable fact 6',
    text: 'x'.repeat(1_000),
  })
  assert.match(written, /Auto-compacted the shared memory: \d+ → \d+ characters \(4 file\(s\) moved to memory\/archive\/\)/)

  // The newest two files survive; the oldest four moved out whole.
  assert.deepEqual(await liveMemoryNames(projectId), ['s5-durable-fact.md', 's6-durable-fact.md'])
  assert.deepEqual(await archiveNames(projectId), [
    's1-durable-fact.md',
    's2-durable-fact.md',
    's3-durable-fact.md',
    's4-durable-fact.md',
  ])
  for (let index = 1; index <= 4; index += 1) {
    const archived = await readFileOr(join(archiveDirOf(projectId), `s${index}-durable-fact.md`))
    // Whole file, frontmatter included: nothing was split or rewritten.
    assert.match(
      archived,
      new RegExp(`^---\\nname: s${index}-durable-fact\\ndescription: Durable fact ${index}\\ntype: reference\\nmodified: \\d{4}-\\d{2}-\\d{2}T`),
    )
    assert.ok(archived.includes('x'.repeat(1_000)), `s${index} moved verbatim`)
  }

  const record = (await storedProject(projectId)).lastCompaction
  assert.equal(record.archived, 4)
  assert.ok(record.before > record.after)
  assert.ok(record.at > 0)

  // The compaction is visible where a human/coordinator looks, and the index
  // reflects the live files rather than the archived ones.
  const detail = await call('projects_get', { project_id: projectId })
  assert.match(detail, /memory: budget 4000, auto-compaction on · last compaction \d+ → \d+ characters at /)
  assert.match(detail, /· s6-durable-fact — Durable fact 6（1000 chars，\d{4}-\d{2}-\d{2}）/)
  assert.doesNotMatch(detail, /s1-durable-fact/)

  // The dispatch prompt carries the same index, so a worker cannot be handed
  // text that only exists in the archive.
  const added = await call('projects_add_task', { project_id: projectId, title: 'Read the memory' })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  await call('projects_dispatch', { project_id: projectId, task_id: taskId })
  const prompt = activations[activations.length - 1].prompt[0].text
  assert.match(prompt, /· s6-durable-fact — Durable fact 6（1000 chars/)
  assert.doesNotMatch(prompt, /s1-durable-fact/)
})

test('compaction is single-flight per project', async () => {
  // Compaction off from the start, so the setup writes cannot compact and the two
  // direct calls below are the only compactions in play.
  const projectId = await newProject('Single flight', { memoryBudget: 4_000, autoCompact: false })
  await writeMemoryFixtures(projectId, memoryFileFixtures(6, 1_000))
  assert.equal((await liveMemoryNames(projectId)).length, 6)

  // The first call takes the flag synchronously, before its first await, so the
  // second call in the same tick must be refused rather than racing it.
  const first = plugin.compactMemory(projectId)
  const second = await plugin.compactMemory(projectId)
  assert.equal(second.skipped, 'in_flight')

  const firstResult = await first
  assert.equal(firstResult.skipped, null)
  assert.equal(firstResult.archived, 4)

  // One run, one move: the refused call archived nothing extra.
  assert.equal((await archiveNames(projectId)).length, 4)

  // The flag is released, so a later write can compact again.
  const again = await plugin.compactMemory(projectId)
  assert.equal(again.skipped, 'under_budget')
})

test('a failed compaction leaves the memory intact and clears the flag', async () => {
  const projectId = await newProject('Broken archive', { memoryBudget: 4_000, autoCompact: false })
  await writeMemoryFixtures(projectId, memoryFileFixtures(6, 1_000))

  // A regular file where the archive directory belongs makes the archive step
  // fail after the plan was made — exactly the "half-way through" case.
  await writeFile(join(memoryDirOf(projectId), 'archive'), 'not a directory')
  const failed = await plugin.compactMemory(projectId)
  assert.equal(failed.skipped, 'error')
  assert.match(failed.reason, /EEXIST|ENOTDIR|EPERM|EACCES|illegal operation/i)
  // The memory was never replaced, and no compaction is recorded.
  assert.equal((await liveMemoryNames(projectId)).length, 6)
  assert.equal((await storedProject(projectId)).lastCompaction, undefined)

  // The in-flight flag is gone: once the obstacle is removed the next attempt
  // compacts normally instead of being told a run is still going.
  await rm(join(memoryDirOf(projectId), 'archive'), { force: true })
  const retried = await plugin.compactMemory(projectId)
  assert.equal(retried.skipped, null)
  assert.equal((await liveMemoryNames(projectId)).length, 2)
  assert.equal((await archiveNames(projectId)).length, 4)
})

test('a single oversized file is never split, so nothing is archived', async () => {
  const projectId = await newProject('One file', { memoryBudget: 4_000 })
  const written = await call('projects_memory', {
    project_id: projectId,
    action: 'write',
    name: 's1-durable-fact',
    description: 'Durable fact 1',
    text: 'x'.repeat(5_000),
  })
  assert.match(written, /nothing safe to archive: a single file is never split/)
  assert.deepEqual(await archiveNames(projectId), [])
  assert.equal(
    (await call('projects_memory', { project_id: projectId, action: 'read', name: 's1-durable-fact' })).length,
    5_000,
  )
})

test('autoCompact false keeps the memory append-only', async () => {
  const projectId = await newProject('Manual memory', { memoryBudget: 4_000, autoCompact: false })
  await writeMemoryFixtures(projectId, memoryFileFixtures(6, 1_000))
  const written = await call('projects_memory', {
    project_id: projectId,
    action: 'append',
    name: 's6-durable-fact',
    text: 'more',
  })
  assert.match(written, /Auto-compaction is off for this project/)
  assert.equal((await liveMemoryNames(projectId)).length, 6)
  assert.deepEqual(await archiveNames(projectId), [])
  assert.equal((await storedProject(projectId)).lastCompaction, undefined)

  // The coordinator can turn it back on, and the next write compacts.
  const updated = await call('projects_update', { project_id: projectId, autoCompact: true, memoryBudget: 5_000 })
  assert.match(updated, /memory=5000 autoCompact=true/)
  const appended = await call('projects_memory', {
    project_id: projectId,
    action: 'append',
    name: 's6-durable-fact',
    text: 'more',
  })
  assert.match(appended, /Auto-compacted the shared memory/)
  assert.ok((await archiveNames(projectId)).length > 0)
})

test('the page memory editor compacts too, and the settings round-trip', async () => {
  const projectId = await newProject('Page memory', { memoryBudget: 4_000, autoCompact: false })
  await writeMemoryFixtures(projectId, memoryFileFixtures(6, 1_000))
  await call('projects_update', { project_id: projectId, autoCompact: true })

  const saved = await request('POST', `/projects-api/projects/${projectId}/memory`, {
    name: 's6-durable-fact',
    text: 'x'.repeat(1_000),
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.saved, true)
  assert.equal(saved.body.name, 's6-durable-fact')
  assert.equal(saved.body.size, 1_000)
  assert.match(saved.body.compaction, /Auto-compacted the shared memory/)
  assert.equal((await archiveNames(projectId)).length, 4)

  // The single-file route returns the body the editor edits.
  const read = await request('GET', `/projects-api/projects/${projectId}/memory/s6-durable-fact`)
  assert.equal(read.status, 200)
  assert.equal(read.body.name, 's6-durable-fact')
  assert.equal(read.body.text, 'x'.repeat(1_000))
  assert.match(read.body.modified, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(read.body.archived, false)
  // An archived file is still readable, and says it is archived.
  const archived = await request('GET', `/projects-api/projects/${projectId}/memory/s1-durable-fact`)
  assert.equal(archived.status, 200)
  assert.equal(archived.body.archived, true)
  assert.equal(archived.body.text, 'x'.repeat(1_000))
  // An unknown file is a 404.
  const missing = await request('GET', `/projects-api/projects/${projectId}/memory/nope`)
  assert.equal(missing.status, 404)

  // Project settings are visible on the project payload the page already reads.
  const patched = await request('PATCH', `/projects-api/projects/${projectId}`, { autoCompact: false, memoryBudget: 9_000 })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.project.autoCompact, false)
  assert.equal(patched.body.project.memoryBudget, 9_000)
  assert.ok(patched.body.project.lastCompaction.at > 0)

  // A string "false" must not silently disable compaction: only a real boolean
  // flips it, so the setting stays on.
  const restored = await request('PATCH', `/projects-api/projects/${projectId}`, { autoCompact: true })
  assert.equal(restored.body.project.autoCompact, true)
  const sneaky = await request('PATCH', `/projects-api/projects/${projectId}`, { autoCompact: 'false' })
  assert.equal(sneaky.body.project.autoCompact, true)
  // Out-of-range budgets are clamped, not rejected.
  const clamped = await request('PATCH', `/projects-api/projects/${projectId}`, { memoryBudget: 1 })
  assert.equal(clamped.body.project.memoryBudget, 4_000)
})

test('an archived file is still readable, and the index says so', async () => {
  const projectId = await newProject('Archive reading', { memoryBudget: 4_000, autoCompact: false })
  await writeMemoryFixtures(projectId, memoryFileFixtures(6, 1_000))
  const compacted = await plugin.compactMemory(projectId)
  assert.equal(compacted.archived, 4)

  // s1 moved out of the live memory, but reading it by name still works and says
  // where it came from.
  const archived = await call('projects_memory', { project_id: projectId, action: 'read', name: 's1-durable-fact' })
  assert.match(archived, /^x{1000}/)
  assert.match(archived, /\(Archived: compaction moved this file into memory\/archive\//)

  // A live file is returned without the archive note.
  const live = await call('projects_memory', { project_id: projectId, action: 'read', name: 's6-durable-fact' })
  assert.match(live, /^x{1000}/)
  assert.doesNotMatch(live, /Archived:/)

  // The tool's index lists what was archived, so it stays discoverable...
  const index = await call('projects_memory', { project_id: projectId, action: 'index' })
  assert.match(index, /2 file\(s\), \d+ characters/)
  assert.match(index, /4 archived file\(s\) in memory\/archive\//)
  assert.match(index, /- s1-durable-fact \(\d+ chars\)/)
  assert.ok(index.indexOf('archived file(s)') > index.indexOf('2 file(s)'), 'the live index comes first')
  // ...while the worker prompt's index does not (workers act on current memory).
  const added = await call('projects_add_task', { project_id: projectId, title: 'probe' })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  await call('projects_dispatch', { project_id: projectId, task_id: taskId })
  const prompt = activations[activations.length - 1].prompt[0].text
  assert.match(prompt, /· s6-durable-fact — /)
  assert.doesNotMatch(prompt, /s1-durable-fact/)
  assert.doesNotMatch(prompt, /memory\/archive/)

  // A miss names both stores.
  await assert.rejects(
    () => call('projects_memory', { project_id: projectId, action: 'read', name: 'no such file' }),
    /Archived files are searchable too/,
  )
})

// ---------------------------------------------------------------------------
// Deleting a task and the worker session behind it.
//
// DeepSeek Harness has no session deletion at all — `sessions` and
// `sessionPersistence` expose no delete, and the product documents that sessions
// "can be archived but are never deleted". So the host supports exactly one
// session action on task delete, `?session=archive`, and refuses every delete
// spelling instead of silently downgrading it. These tests drive the injected
// `workspaceRegistry` above; no real session store is touched.

/** Create a project with one dispatched task, so the task carries a childSessionId. */
async function projectWithWorker(title) {
  const created = await call('projects_create', { name: `Sessions · ${title}`, autonomy: 'auto' })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]
  const added = await call('projects_add_task', { project_id: projectId, title })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  await call('projects_dispatch', { project_id: projectId, task_id: taskId })
  return { projectId, taskId }
}

test('deleting a task leaves its worker session alone by default', async () => {
  const { projectId, taskId } = await projectWithWorker('default keeps the session')
  fakeWorkspaceRegistry = createRegistry()

  const response = await request('DELETE', `/projects-api/projects/${projectId}/tasks/${taskId}`)
  assert.equal(response.status, 200)
  assert.equal(response.body.deleted, true)
  assert.equal(response.body.session, null)
  assert.equal(fakeWorkspaceRegistry.calls.length, 0, 'no archive call without the parameter')

  const detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.body.project.tasks.length, 0)
})

test('?session=archive archives the task\'s own worker session, then drops the task', async () => {
  const { projectId, taskId } = await projectWithWorker('archive the worker')
  fakeWorkspaceRegistry = createRegistry()

  const response = await request(
    'DELETE',
    `/projects-api/projects/${projectId}/tasks/${taskId}?session=archive`,
  )
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.session, { id: 'child-session-1', archived: true })
  // The id comes from the task row, never from the request.
  assert.deepEqual(fakeWorkspaceRegistry.calls.map((entry) => entry.sessionId), ['child-session-1'])
  assert.equal(fakeWorkspaceRegistry.calls[0].options, undefined, 'running work is not stopped implicitly')

  const detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.body.project.tasks.length, 0)
})

test('the coordinator session is never archived', async () => {
  const { projectId, taskId } = await projectWithWorker('coordinator guard')
  fakeWorkspaceRegistry = createRegistry()
  // Simulate the collision the guard exists for: the task's worker id is also
  // recorded as the project's coordinator session.
  const patched = await request('PATCH', `/projects-api/projects/${projectId}`, {
    coordinatorSessionId: 'child-session-1',
  })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.project.coordinatorSessionId, 'child-session-1')

  const response = await request(
    'DELETE',
    `/projects-api/projects/${projectId}/tasks/${taskId}?session=archive`,
  )
  assert.equal(response.status, 409)
  assert.match(response.body.error, /coordinator session/)
  assert.equal(fakeWorkspaceRegistry.calls.length, 0, 'the coordinator is not even asked about')

  const detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.body.project.tasks.length, 1, 'the task survives a refused archive')
})

test('a failed archive keeps the task on the board', async () => {
  const { projectId, taskId } = await projectWithWorker('archive failure')
  fakeWorkspaceRegistry = createRegistry()
  fakeWorkspaceRegistry.failWith = new Error('registry is read-only')

  const response = await request(
    'DELETE',
    `/projects-api/projects/${projectId}/tasks/${taskId}?session=archive`,
  )
  assert.equal(response.status, 500)
  assert.match(response.body.error, /could not archive session child-session-1/)
  assert.equal(fakeWorkspaceRegistry.calls.length, 1)

  const detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.body.project.tasks.length, 1, 'no dangling reference is left behind')
  assert.equal(detail.body.project.tasks[0].id, taskId)
})

test('an active worker is refused instead of being stopped behind the user', async () => {
  const { projectId, taskId } = await projectWithWorker('still running')
  fakeWorkspaceRegistry = createRegistry()
  const active = new Error("cannot archive session 'child-session-1': the session is active (agent)")
  active.name = 'WorkspaceActiveSessionError'
  fakeWorkspaceRegistry.failWith = active

  const response = await request(
    'DELETE',
    `/projects-api/projects/${projectId}/tasks/${taskId}?session=archive`,
  )
  assert.equal(response.status, 409)
  assert.match(response.body.error, /still running/)
  assert.match(response.body.error, /stop it first/)

  const detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.body.project.tasks.length, 1)
})

test('a session that is already gone does not block the delete', async () => {
  const { projectId, taskId } = await projectWithWorker('session already gone')
  fakeWorkspaceRegistry = createRegistry()
  const unknown = new Error('no such session')
  unknown.name = 'WorkspaceUnknownSessionError'
  fakeWorkspaceRegistry.failWith = unknown

  const response = await request(
    'DELETE',
    `/projects-api/projects/${projectId}/tasks/${taskId}?session=archive`,
  )
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.session, { id: 'child-session-1', archived: false })

  const detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.body.project.tasks.length, 0)
})

test('a session delete request is refused, not silently downgraded to archive', async () => {
  const { projectId, taskId } = await projectWithWorker('delete refused')
  fakeWorkspaceRegistry = createRegistry()

  for (const spelling of ['1', 'true', 'delete', 'remove']) {
    const response = await request(
      'DELETE',
      `/projects-api/projects/${projectId}/tasks/${taskId}?session=${spelling}`,
    )
    assert.equal(response.status, 400, `?session=${spelling} must refuse`)
    assert.match(response.body.error, /cannot delete a session/)
    assert.match(response.body.error, /session=archive/, 'the refusal names the supported action')
  }
  assert.equal(fakeWorkspaceRegistry.calls.length, 0)

  const detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.body.project.tasks.length, 1, 'a refused request deletes nothing')
})

test('an unknown session action is rejected', async () => {
  const { projectId, taskId } = await projectWithWorker('unknown action')
  fakeWorkspaceRegistry = createRegistry()
  const response = await request(
    'DELETE',
    `/projects-api/projects/${projectId}/tasks/${taskId}?session=purge`,
  )
  assert.equal(response.status, 400)
  assert.match(response.body.error, /unknown session action "purge"/)
  assert.equal(fakeWorkspaceRegistry.calls.length, 0)
})

test('a task that never ran has no session to archive', async () => {
  const created = await call('projects_create', { name: 'Sessions · never dispatched', autonomy: 'auto' })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]
  const added = await call('projects_add_task', { project_id: projectId, title: 'Queued only' })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  fakeWorkspaceRegistry = createRegistry()

  const response = await request(
    'DELETE',
    `/projects-api/projects/${projectId}/tasks/${taskId}?session=archive`,
  )
  assert.equal(response.status, 200)
  assert.equal(response.body.session, null)
  assert.equal(fakeWorkspaceRegistry.calls.length, 0)
})

test('archiving without a workspace registry service is refused', async () => {
  const { projectId, taskId } = await projectWithWorker('no registry')
  fakeWorkspaceRegistry = undefined
  try {
    const response = await request(
      'DELETE',
      `/projects-api/projects/${projectId}/tasks/${taskId}?session=archive`,
    )
    assert.equal(response.status, 503)
    assert.equal(response.body.error, 'workspace_registry_unavailable')
  } finally {
    fakeWorkspaceRegistry = createRegistry()
  }

  const detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.body.project.tasks.length, 1, 'the task is kept when the session cannot be archived')
})

test('deleting an unknown task is a 404 and archives nothing', async () => {
  const { projectId } = await projectWithWorker('unknown task')
  fakeWorkspaceRegistry = createRegistry()
  const response = await request(
    'DELETE',
    `/projects-api/projects/${projectId}/tasks/t-deadbeef?session=archive`,
  )
  assert.equal(response.status, 404)
  assert.equal(response.body.error, 'task_not_found')
  assert.equal(fakeWorkspaceRegistry.calls.length, 0)
})
