/**
 * Host-half smoke test: load the plugin with a fake Cordis context, exercise
 * every tool against a temporary DSH_HOME, dispatch a fake worker, settle it,
 * and read the board back through the HTTP route handler.
 *
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

  // The coordinator still writes the system status; "resolved" is the human's
  // verdict and is not reachable from this tool.
  const updated = await call('projects_update_task', {
    project_id: projectId,
    task_id: taskId,
    status: 'blocked',
    output: 'Three variants delivered.',
  })
  assert.match(updated, /is now blocked/)
  launchProjectId = projectId
})

test('shared memory append and replace', async () => {
  const list = await call('projects_list', {})
  const projectId = list.match(/p-[0-9a-f]{8}/)[0]
  await call('projects_memory', { project_id: projectId, action: 'append', text: 'Repo uses pnpm.' })
  await call('projects_memory', { project_id: projectId, action: 'append', text: 'Copy lives in /content.' })
  const memory = await call('projects_memory', { project_id: projectId })
  assert.match(memory, /Repo uses pnpm\./)
  assert.match(memory, /Copy lives in \/content\./)
  await call('projects_memory', { project_id: projectId, action: 'write', text: 'Only this.' })
  assert.equal(await call('projects_memory', { project_id: projectId }), 'Only this.')
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
  assert.match(prompt, /## Shared project memory\n10 characters, no "## " headings/)
  assert.match(prompt, /projects_memory \{project_id:"p-[0-9a-f]{8}", action:"read", section:"<title>"\}/)
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
  assert.match(detail.body.memory, /Only this\./)

  const missing = await request('GET', '/projects-api/projects/p-deadbeef')
  assert.equal(missing.status, 404)
})

// ---------------------------------------------------------------------------
// Status is system-only; the page may write nothing but `resolved`.

test('the page cannot write task status, output or approval', async () => {
  const detail = await request('GET', `/projects-api/projects/${launchProjectId}`)
  assert.equal(detail.status, 200)
  const task = detail.body.project.tasks[0]
  assert.equal(task.status, 'blocked')
  assert.equal(task.resolved, false)
  const path = `/projects-api/projects/${launchProjectId}/tasks/${task.id}`

  // A stale bundle that still tries to mark the task "done" must fail loudly.
  const status = await request('PATCH', path, { status: 'done' })
  assert.equal(status.status, 400)
  assert.match(status.body.error, /only "resolved" is writable/)
  assert.match(status.body.error, /status/)

  const output = await request('PATCH', path, { output: 'forged output' })
  assert.equal(output.status, 400)

  const approved = await request('PATCH', path, { approved: true })
  assert.equal(approved.status, 400)

  // A smuggled extra field poisons the whole patch instead of half-applying.
  const smuggled = await request('PATCH', path, { resolved: true, status: 'done' })
  assert.equal(smuggled.status, 400)

  const empty = await request('PATCH', path, {})
  assert.equal(empty.status, 400)
  assert.match(empty.body.error, /resolved/)

  const notBoolean = await request('PATCH', path, { resolved: 'yes' })
  assert.equal(notBoolean.status, 400)

  // Nothing leaked through.
  const after = await request('GET', `/projects-api/projects/${launchProjectId}`)
  const untouched = after.body.project.tasks[0]
  assert.equal(untouched.status, 'blocked')
  assert.equal(untouched.output, 'Three variants delivered.')
  assert.equal(untouched.approved, false)
  assert.equal(untouched.resolved, false)
})

test('the page resolves a task and the verdict is persisted', async () => {
  const detail = await request('GET', `/projects-api/projects/${launchProjectId}`)
  const task = detail.body.project.tasks[0]
  const path = `/projects-api/projects/${launchProjectId}/tasks/${task.id}`

  const resolved = await request('PATCH', path, { resolved: true })
  assert.equal(resolved.status, 200)
  assert.equal(resolved.body.task.resolved, true)
  // Resolving is not a status change: the system status stays where it was.
  assert.equal(resolved.body.task.status, 'blocked')

  // Written to disk, not just echoed back.
  const onDisk = JSON.parse(await readFile(join(home, 'projects', launchProjectId, 'project.json'), 'utf8'))
  assert.equal(onDisk.tasks[0].resolved, true)

  const cleared = await request('PATCH', path, { resolved: false })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.task.resolved, false)

  const again = await request('PATCH', path, { resolved: true })
  assert.equal(again.body.task.resolved, true)
})

test('the create-task HTTP route is gone', async () => {
  const created = await request('POST', `/projects-api/projects/${launchProjectId}/tasks`, { title: 'Sneaky task' })
  assert.equal(created.status, 404)

  const detail = await request('GET', `/projects-api/projects/${launchProjectId}`)
  assert.equal(detail.body.project.tasks.length, 2)
})

test('the coordinator tool cannot resolve a task', async () => {
  const definition = tool('projects_update_task')
  assert.equal(definition.parameters.properties.resolved, undefined)
  assert.deepEqual(definition.parameters.properties.status.enum, ['queued', 'running', 'review', 'failed', 'blocked'])

  const detail = await request('GET', `/projects-api/projects/${launchProjectId}`)
  const task = detail.body.project.tasks[0]
  assert.equal(task.resolved, true)

  // Even if the argument slips past the schema, execute must drop it.
  await call('projects_update_task', { project_id: launchProjectId, task_id: task.id, resolved: false })
  const after = await request('GET', `/projects-api/projects/${launchProjectId}`)
  assert.equal(after.body.project.tasks[0].resolved, true)
})

test('reading a legacy project migrates status "done" to review + resolved', async () => {
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
    ],
  }
  await writeFile(join(dir, 'project.json'), `${JSON.stringify(legacy, null, 2)}\n`)

  const detail = await request('GET', `/projects-api/projects/${projectId}`)
  assert.equal(detail.status, 200)
  const [migrated, queued, bogus] = detail.body.project.tasks
  assert.equal(migrated.status, 'review')
  assert.equal(migrated.resolved, true)
  assert.equal(queued.status, 'queued')
  assert.equal(queued.resolved, false)
  assert.equal(bogus.status, 'queued')
  assert.equal(bogus.resolved, false)

  // "done" is gone from the tally as well.
  const list = await request('GET', '/projects-api/projects')
  const summary = list.body.projects.find((project) => project.id === projectId)
  assert.ok(summary, 'legacy project is listed')
  assert.equal(summary.counts.done, undefined)
  assert.equal(summary.counts.review, 1)
})

// ---------------------------------------------------------------------------
// The manual-mode gate has its own narrow POST route; PATCH stays resolved-only.

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
  assert.match(patched.body.error, /only "resolved" is writable/)

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
// The shared memory is a long append-only log. Workers get an index of it and
// pull the one section they need, so the prompt stays bounded.

/** A project whose memory has two sections, each with a description line and a body-only marker. */
async function memoryProject(name) {
  const created = await call('projects_create', { name, goal: 'Ship it.', autonomy: 'auto' })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]
  await call('projects_memory', {
    project_id: projectId,
    action: 'write',
    text: [
      '## Alpha decisions',
      'Copy lives in /content.',
      'BODY-ALPHA-MARKER the copy lives in /content.',
      '',
      '## Beta gotchas',
      'pnpm only, no npm.',
      'BODY-BETA-MARKER pnpm only, no npm.',
      '',
    ].join('\n'),
  })
  return projectId
}

test('the dispatch prompt carries a memory index instead of the memory', async () => {
  const projectId = await memoryProject('Indexed memory')
  const added = await call('projects_add_task', { project_id: projectId, title: 'Tweak a button' })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  await call('projects_dispatch', { project_id: projectId, task_id: taskId })

  const prompt = activations[activations.length - 1].prompt[0].text
  // Only the one-line description leaks, never the rest of a section body.
  assert.doesNotMatch(prompt, /BODY-ALPHA-MARKER/)
  assert.doesNotMatch(prompt, /BODY-BETA-MARKER/)
  // The index lists both titles with a description and a size, and says how to
  // read one or search for one.
  assert.match(prompt, /## Shared project memory\n2 section\(s\), \d+ characters\./)
  assert.match(prompt, /· Alpha decisions — Copy lives in \/content\.（\d+ chars）/)
  assert.match(prompt, /· Beta gotchas — pnpm only, no npm\.（\d+ chars）/)
  assert.match(prompt, /not its contents/)
  assert.match(prompt, /action:"read", section:"<title>"/)
  assert.match(prompt, /action:"search", query:"<keyword>"/)
  // The closing instruction to append findings survives.
  assert.match(prompt, /action "append"/)
})

test('an oversized memory index is truncated and says how many sections are missing', async () => {
  const created = await call('projects_create', { name: 'Huge memory', goal: 'Ship it.', autonomy: 'auto' })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]
  // 200 sections: the full format, the no-description format and the title-only
  // format all overflow 2000 characters, so the index must truncate.
  const sections = []
  for (let index = 0; index < 200; index += 1) {
    sections.push(`## Long history section ${index}`, `BODY-HIDDEN-${index} ${'x'.repeat(200)}`, '')
  }
  await call('projects_memory', { project_id: projectId, action: 'write', text: sections.join('\n') })

  const added = await call('projects_add_task', { project_id: projectId, title: 'Small change' })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  await call('projects_dispatch', { project_id: projectId, task_id: taskId })

  const prompt = activations[activations.length - 1].prompt[0].text
  const index = prompt.split('## Shared project memory\n')[1].split('\n\nThe list above')[0]
  assert.ok(index.length <= 2000, `index is capped, got ${index.length} characters`)
  assert.match(index, /200 section\(s\)/)
  assert.match(index, /truncated to fit the 2000-character index cap/)
  assert.match(index, /· Long history section 0\n/)
  assert.match(index, /- …and \d+ more section\(s\) not listed \(index capped at 2000 characters\)\./)
  // Truncation drops whole sections, never a description: no body leaks.
  assert.doesNotMatch(prompt, /BODY-HIDDEN-/)
})

test('projects_memory index lists titles, descriptions and sizes without any body', async () => {
  const projectId = await memoryProject('Index action')
  const index = await call('projects_memory', { project_id: projectId, action: 'index' })
  assert.match(index, /2 section\(s\), \d+ characters\./)
  assert.match(index, /· Alpha decisions — Copy lives in \/content\.（\d+ chars）/)
  assert.match(index, /· Beta gotchas — pnpm only, no npm\.（\d+ chars）/)
  assert.doesNotMatch(index, /BODY-ALPHA-MARKER/)
  assert.doesNotMatch(index, /BODY-BETA-MARKER/)
})

test('projects_memory read with a section returns only that section', async () => {
  const projectId = await memoryProject('Section read')

  const exact = await call('projects_memory', { project_id: projectId, action: 'read', section: 'Beta gotchas' })
  assert.match(exact, /^## Beta gotchas\n\npnpm only, no npm\.\nBODY-BETA-MARKER pnpm only, no npm\.$/)
  assert.doesNotMatch(exact, /BODY-ALPHA-MARKER/)

  // Matching is forgiving: case-insensitive, prefix and substring both work.
  const prefix = await call('projects_memory', { project_id: projectId, action: 'read', section: 'alpha' })
  assert.match(prefix, /BODY-ALPHA-MARKER/)
  assert.doesNotMatch(prefix, /BODY-BETA-MARKER/)
  const substring = await call('projects_memory', { project_id: projectId, action: 'read', section: 'gotcha' })
  assert.match(substring, /BODY-BETA-MARKER/)

  // An unknown section fails loudly and lists what does exist.
  await assert.rejects(
    () => call('projects_memory', { project_id: projectId, action: 'read', section: 'nope' }),
    /No memory section matches "nope"\. Sections: Alpha decisions \| Beta gotchas/,
  )
})

test('projects_memory read without a section still returns the whole file', async () => {
  const projectId = await memoryProject('Whole read')
  const whole = await call('projects_memory', { project_id: projectId })
  assert.match(whole, /BODY-ALPHA-MARKER/)
  assert.match(whole, /BODY-BETA-MARKER/)
  assert.match(whole, /## Alpha decisions/)
  // `action: 'read'` is the same thing, spelled out.
  assert.equal(await call('projects_memory', { project_id: projectId, action: 'read' }), whole)
})

/** A project whose memory is built from `[title, body]` pairs. */
async function projectWithMemory(name, sections) {
  const created = await call('projects_create', { name, goal: 'Ship it.', autonomy: 'auto' })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]
  const text = sections.map(([title, body]) => `## ${title}\n${body}\n`).join('\n')
  await call('projects_memory', { project_id: projectId, action: 'write', text })
  return projectId
}

/** `count` sections whose first body line is exactly 80 characters long. */
function describedMemory(count, tag = 'Section') {
  const sections = []
  for (let index = 0; index < count; index += 1) {
    sections.push([`${tag} ${index}`, `${'d'.repeat(80)}\nBODY-${tag}-${index}`])
  }
  return sections
}

/** The memory index a dispatched worker's prompt carries. */
async function promptMemoryIndex(projectId) {
  const added = await call('projects_add_task', { project_id: projectId, title: 'Read the memory' })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  await call('projects_dispatch', { project_id: projectId, task_id: taskId })
  const prompt = activations[activations.length - 1].prompt[0].text
  return prompt.split('## Shared project memory\n')[1].split('\n\nThe list above')[0]
}

test('index descriptions are the first body line, markdown stripped and truncated', async () => {
  const long = 'L'.repeat(120)
  const projectId = await projectWithMemory('Described memory', [
    ['Styled section', '- **Bold** `code` and _plain_ text\nBODY-STYLED-HIDDEN'],
    ['Deep section', '#### Deep heading\nBODY-DEEP-HIDDEN'],
    ['Truncated section', `${long}\nBODY-LONG-HIDDEN`],
    ['Empty section', ''],
    ['Dated section (2026-11-16, agent-1)', 'Dated body.'],
  ])
  const index = await call('projects_memory', { project_id: projectId, action: 'index' })
  // First non-empty line, with heading hashes, list bullets, bold and code
  // markers stripped.
  assert.match(index, /· Styled section — Bold code and _plain_ text（\d+ chars）/)
  assert.match(index, /· Deep section — Deep heading（\d+ chars）/)
  // Longer than 80 characters: cut at 80 and marked with an ellipsis.
  assert.match(index, new RegExp(`· Truncated section — ${'L'.repeat(80)}…（\\d+ chars）`))
  // No body, no description: the line falls back to title + size.
  assert.match(index, /· Empty section（0 chars）/)
  // The date in the title is carried into the index; no date means no date.
  assert.match(index, /· Dated section \(2026-11-16, agent-1\) — Dated body\.（\d+ chars，2026-11-16）/)
  assert.doesNotMatch(index, /· Styled section[^\n]*，20\d\d-\d\d-\d\d/)
  // Descriptions never drag the rest of the body in.
  assert.doesNotMatch(index, /BODY-STYLED-HIDDEN|BODY-DEEP-HIDDEN|BODY-LONG-HIDDEN/)
})

test('projects_memory search matches titles and bodies without returning bodies', async () => {
  const projectId = await projectWithMemory('Searchable memory', [
    ['Alpha decisions', 'The copy lives in /content.\nBODY-ALPHA-SECRET'],
    ['Beta gotchas', 'pnpm only, no npm.\nBODY-BETA-SECRET'],
    ['Gamma notes', 'Alpha is mentioned here too.\nBODY-GAMMA-SECRET'],
    ['Old plan [superseded]', 'Alpha plan that was replaced.\nBODY-OLD-SECRET'],
  ])

  // A title match returns the section's title, description and size.
  const byTitle = await call('projects_memory', { project_id: projectId, action: 'search', query: 'beta' })
  assert.match(byTitle, /1 section\(s\) match "beta"/)
  assert.match(byTitle, /· Beta gotchas — pnpm only, no npm\.（\d+ chars）/)
  assert.doesNotMatch(byTitle, /BODY-BETA-SECRET/)

  // A body match is case-insensitive and can return several sections; the
  // superseded section contains the keyword too but is excluded.
  const byBody = await call('projects_memory', { project_id: projectId, action: 'search', query: 'ALPHA' })
  assert.match(byBody, /2 section\(s\) match "ALPHA"/)
  assert.match(byBody, /· Alpha decisions — The copy lives in \/content\./)
  assert.match(byBody, /· Gamma notes — Alpha is mentioned here too\./)
  assert.doesNotMatch(byBody, /BODY-ALPHA-SECRET|BODY-GAMMA-SECRET/)
  assert.doesNotMatch(byBody, /Old plan/)

  // No match says so and points at the index.
  const miss = await call('projects_memory', { project_id: projectId, action: 'search', query: 'zebra' })
  assert.match(miss, /No memory section matches "zebra"/)
  assert.match(miss, /action:"index"/)

  // A missing query is a loud error, not an empty result.
  await assert.rejects(
    () => call('projects_memory', { project_id: projectId, action: 'search' }),
    /query is required for action "search"/,
  )
})

test('search caps its result list and counts the sections left out', async () => {
  const sections = []
  for (let index = 0; index < 12; index += 1) {
    sections.push([`Match ${index}`, `keyword appears in section ${index}.`])
  }
  const projectId = await projectWithMemory('Many matches', sections)
  const result = await call('projects_memory', { project_id: projectId, action: 'search', query: 'keyword' })
  assert.match(result, /12 section\(s\) match "keyword", showing the first 10/)
  assert.match(result, /- …and 2 more section\(s\) match; narrow the query or use action:"index"\./)
  assert.equal((result.match(/^· /gm) || []).length, 10)
})

test('stale sections leave the index and search but stay readable by name', async () => {
  const projectId = await projectWithMemory('Stale memory', [
    ['Live decision', 'Use pnpm.\nBODY-LIVE'],
    ['Old decision [superseded]', 'Use npm.\nBODY-OLD'],
    ['Ancient notes [ARCHIVED]', 'Nothing to see.\nBODY-ANCIENT'],
  ])

  const index = await call('projects_memory', { project_id: projectId, action: 'index' })
  assert.match(index, /1 section\(s\), \d+ characters\./)
  assert.match(index, /· Live decision — Use pnpm\./)
  assert.doesNotMatch(index, /· Old decision/)
  assert.doesNotMatch(index, /· Ancient notes/)
  // They are still named once, titles only, so a reader knows history exists.
  assert.match(
    index,
    /2 section\(s\) marked stale \(superseded\/archived; still readable by name\): Old decision \[superseded\] \| Ancient notes \[ARCHIVED\]/,
  )

  const search = await call('projects_memory', { project_id: projectId, action: 'search', query: 'npm' })
  assert.match(search, /1 section\(s\) match "npm"/)
  assert.match(search, /· Live decision/)
  assert.doesNotMatch(search, /Old decision|Ancient notes/)

  // Read by name still works, marker included...
  const old = await call('projects_memory', { project_id: projectId, action: 'read', section: 'Old decision' })
  assert.match(old, /^## Old decision \[superseded\]\n\nUse npm\./)
  assert.match(old, /BODY-OLD/)
  // ...and a whole-file read still contains every section.
  const whole = await call('projects_memory', { project_id: projectId })
  assert.match(whole, /BODY-OLD/)
  assert.match(whole, /BODY-ANCIENT/)

  // The worker prompt's index drops them entirely: workers act on current
  // knowledge, while the coordinator's index still names them above.
  const promptIndex = await promptMemoryIndex(projectId)
  assert.doesNotMatch(promptIndex, /Old decision|Ancient notes|marked stale/)
})

test('the index degrades in a fixed ladder when it exceeds its cap', async () => {
  // 10 sections: the full format (title + description + size) fits 2000.
  const small = await projectWithMemory('Ladder small', describedMemory(10))
  const smallIndex = await promptMemoryIndex(small)
  assert.match(smallIndex, /· Section 0 — d{80}（\d+ chars）/)
  assert.doesNotMatch(smallIndex, /Descriptions omitted|Titles only|truncated/)

  // 20 sections: descriptions no longer fit, sizes still do.
  const medium = await projectWithMemory('Ladder medium', describedMemory(20))
  const mediumIndex = await promptMemoryIndex(medium)
  assert.match(mediumIndex, /Descriptions omitted to fit the 2000-character index cap\./)
  assert.match(mediumIndex, /· Section 0（\d+ chars）/)
  assert.doesNotMatch(mediumIndex, /· Section 0 —/)
  assert.ok(mediumIndex.length <= 2000, `prompt index is capped, got ${mediumIndex.length}`)

  // 90 sections: only titles fit 2000; the tool's 8000-character index keeps
  // the sizes, which is the same ladder at a different threshold.
  const large = await projectWithMemory('Ladder large', describedMemory(90))
  const largeIndex = await promptMemoryIndex(large)
  assert.match(largeIndex, /Titles only \(descriptions and sizes omitted\) to fit the 2000-character index cap\./)
  assert.match(largeIndex, /· Section 0\n/)
  assert.doesNotMatch(largeIndex, /· Section 0（/)
  assert.ok(largeIndex.length <= 2000, `prompt index is capped, got ${largeIndex.length}`)
  const largeToolIndex = await call('projects_memory', { project_id: large, action: 'index' })
  assert.match(largeToolIndex, /Descriptions omitted to fit the 8000-character index cap\./)
  assert.match(largeToolIndex, /· Section 0（\d+ chars）/)
  assert.ok(largeToolIndex.length <= 8000, `tool index is capped, got ${largeToolIndex.length}`)

  // 200 sections: even titles do not fit, so the list is truncated and counted.
  const huge = await projectWithMemory('Ladder huge', describedMemory(200))
  const hugeIndex = await promptMemoryIndex(huge)
  assert.match(hugeIndex, /truncated to fit the 2000-character index cap/)
  assert.match(hugeIndex, /- …and \d+ more section\(s\) not listed \(index capped at 2000 characters\)\./)
  assert.ok(hugeIndex.length <= 2000, `prompt index is capped, got ${hugeIndex.length}`)
  assert.doesNotMatch(hugeIndex, /d{80}/)
})

test('the tool index is capped at 8000 characters too', async () => {
  // 700 sections with 80-character descriptions: the full, no-description and
  // title-only formats all overflow 8000, so the tool's index truncates too.
  const created = await call('projects_create', {
    name: 'Tool cap',
    goal: 'Ship it.',
    autonomy: 'auto',
    memoryBudget: 200_000,
  })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]
  const text = describedMemory(700)
    .map(([title, body]) => `## ${title}\n${body}\n`)
    .join('\n')
  await call('projects_memory', { project_id: projectId, action: 'write', text })
  const index = await call('projects_memory', { project_id: projectId, action: 'index' })
  assert.ok(index.length <= 8000, `tool index is capped, got ${index.length}`)
  assert.match(index, /truncated to fit the 8000-character index cap/)
  assert.match(index, /- …and \d+ more section\(s\) not listed \(index capped at 8000 characters\)\./)
  assert.doesNotMatch(index, /d{80}/)
})

test('projects_get returns the memory index, not the memory body', async () => {
  const projectId = await memoryProject('Indexed get')
  const detail = await call('projects_get', { project_id: projectId })
  assert.match(detail, /## Shared memory\n2 section\(s\)/)
  assert.match(detail, /· Alpha decisions — Copy lives in \/content\.（\d+ chars）/)
  assert.doesNotMatch(detail, /BODY-ALPHA-MARKER/)
})

test('appending past the memory budget warns instead of truncating silently', async () => {
  const created = await call('projects_create', { name: 'Fat memory', goal: 'Ship it.', autonomy: 'auto' })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]
  await call('projects_memory', { project_id: projectId, action: 'write', text: '## Start\n\nsmall.\n' })

  const big = `## Bulk\n\n${'y'.repeat(65_000)}\n`
  const appended = await call('projects_memory', { project_id: projectId, action: 'append', text: big })
  assert.match(appended, /Appended \d+ characters/)
  assert.match(appended, /WARNING: the shared memory is now \d+ characters, \d+ over the 64000-character budget/)
  assert.doesNotMatch(appended, /hit the 200000-character write ceiling/)

  // Nothing was dropped: the append is on disk in full.
  const whole = await call('projects_memory', { project_id: projectId })
  assert.ok(whole.length > 65_000, `memory kept its bytes, got ${whole.length}`)
  assert.match(whole, /## Bulk/)
})

test('a write past the hard ceiling is reported, not swallowed', async () => {
  const created = await call('projects_create', { name: 'Ceiling memory', goal: 'Ship it.', autonomy: 'auto' })
  const projectId = created.match(/p-[0-9a-f]{8}/)[0]
  const written = await call('projects_memory', { project_id: projectId, action: 'write', text: 'z'.repeat(200_001) })
  assert.match(written, /hit the 200000-character write ceiling and the tail was cut/)
  assert.equal((await call('projects_memory', { project_id: projectId })).length, 200_000)
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
// The memory is an append-only log, so it only grows. Once it crosses the
// project's budget the host archives its oldest whole sections into
// `memory-archive.md` and keeps the rest — deterministic, no LLM, nothing
// summarised away. These tests drive that through both write paths (the tool and
// the page's HTTP route) and pin the safety rails: a backup, a rollback when the
// rewrite is not shorter, and single-flight per project.

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

async function memoryOf(projectId) {
  return readFileOr(join(projectDirOf(projectId), 'memory.md'))
}

async function archiveOf(projectId) {
  return readFileOr(join(projectDirOf(projectId), 'memory-archive.md'))
}

async function backupOf(projectId) {
  return readFileOr(join(projectDirOf(projectId), 'memory.bak.md'))
}

async function storedProject(projectId) {
  return JSON.parse(await readFileOr(join(projectDirOf(projectId), 'project.json'), '{}'))
}

/** A memory of `count` sections of roughly `size` characters each. */
function memoryWithSections(count, size, tag = 'S') {
  const sections = []
  for (let index = 1; index <= count; index += 1) {
    sections.push(`## ${tag}${index} durable fact\n\n${'x'.repeat(size)}`)
  }
  return sections.join('\n\n')
}

async function newProject(name, extra = {}) {
  const created = await call('projects_create', { name, ...extra })
  return created.match(/p-[0-9a-f]{8}/)[0]
}

test('a memory under its budget is not compacted', async () => {
  const projectId = await newProject('Small memory', { memoryBudget: 4_000 })
  const written = await call('projects_memory', {
    project_id: projectId,
    action: 'write',
    text: memoryWithSections(2, 900),
  })
  assert.doesNotMatch(written, /Auto-compacted/)
  assert.equal(await archiveOf(projectId), '')
  assert.equal(await backupOf(projectId), '')
  assert.equal((await storedProject(projectId)).lastCompaction, undefined)
  // And the ordinary budget warning is gone too: nothing is over budget.
  assert.doesNotMatch(written, /WARNING/)
})

test('a memory over its budget archives its oldest sections automatically', async () => {
  const projectId = await newProject('Fat memory', { memoryBudget: 4_000, autonomy: 'auto' })
  const original = memoryWithSections(6, 1_000)
  assert.ok(original.length > 4_000, 'the fixture is over budget')

  const written = await call('projects_memory', { project_id: projectId, action: 'write', text: original })
  assert.match(written, /Auto-compacted the shared memory: \d+ → \d+ characters \(4 section\(s\) moved to memory-archive\.md\)/)

  const memory = await memoryOf(projectId)
  const archive = await archiveOf(projectId)
  const backup = await backupOf(projectId)

  // The newest two sections survive; the oldest four moved out verbatim.
  assert.match(memory, /## S6 durable fact/)
  assert.match(memory, /## S5 durable fact/)
  assert.doesNotMatch(memory, /## S4 durable fact/)
  assert.ok(memory.length <= 4_000, 'the remaining memory fits the budget')

  assert.match(archive, /^## Compaction \d{4}-\d{2}-\d{2}T/)
  assert.match(archive, /Moved 4 section\(s\): S1 durable fact \| S2 durable fact \| S3 durable fact \| S4 durable fact/)
  assert.match(archive, /## S1 durable fact/)
  assert.match(archive, /## S4 durable fact/)
  assert.doesNotMatch(archive, /## S5 durable fact/)
  // Nothing was lost: every archived section's body is present in full.
  for (let index = 1; index <= 4; index += 1) {
    assert.ok(archive.includes(`## S${index} durable fact\n\n${'x'.repeat(1_000)}`), `S${index} moved verbatim`)
  }

  // The pre-compaction text is kept as a manual recovery point.
  assert.equal(backup, original)

  const record = (await storedProject(projectId)).lastCompaction
  assert.equal(record.before, original.length)
  assert.equal(record.after, memory.length)
  assert.equal(record.archived, 4)
  assert.ok(record.at > 0)

  // The compaction is visible where a human/coordinator looks, and the index
  // reflects the compacted file rather than the archived sections.
  const detail = await call('projects_get', { project_id: projectId })
  assert.match(detail, /memory: budget 4000, auto-compaction on · last compaction \d+ → \d+ characters at /)
  assert.match(detail, /· S6 durable fact — x{80}…（1000 chars）/)
  assert.doesNotMatch(detail, /S1 durable fact/)

  // The dispatch prompt carries the same index, so a worker cannot be handed
  // text that only exists in the archive.
  const added = await call('projects_add_task', { project_id: projectId, title: 'Read the memory' })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  await call('projects_dispatch', { project_id: projectId, task_id: taskId })
  const prompt = activations[activations.length - 1].prompt[0].text
  assert.match(prompt, /· S6 durable fact — x{80}…（1000 chars）/)
  assert.doesNotMatch(prompt, /S1 durable fact/)
})

test('compaction is single-flight per project', async () => {
  // Compaction off from the start, so the setup write cannot compact and the two
  // direct calls below are the only compactions in play.
  const projectId = await newProject('Single flight', { memoryBudget: 4_000, autoCompact: false })
  await call('projects_memory', { project_id: projectId, action: 'write', text: memoryWithSections(6, 1_000) })
  assert.ok((await memoryOf(projectId)).length > 4_000)

  // The first call takes the flag synchronously, before its first await, so the
  // second call in the same tick must be refused rather than racing it.
  const first = plugin.compactMemory(projectId)
  const second = await plugin.compactMemory(projectId)
  assert.equal(second.skipped, 'in_flight')

  const firstResult = await first
  assert.equal(firstResult.skipped, null)
  assert.equal(firstResult.archived, 4)

  // One run, one archive header: the refused call archived nothing.
  const archive = await archiveOf(projectId)
  assert.equal(archive.match(/^## Compaction /gm).length, 1)

  // The flag is released, so a later write can compact again.
  const again = await plugin.compactMemory(projectId)
  assert.equal(again.skipped, 'under_budget')
})

test('a failed compaction leaves the memory intact and clears the flag', async () => {
  const projectId = await newProject('Broken archive', { memoryBudget: 4_000 })
  await call('projects_update', { project_id: projectId, autoCompact: false })
  const original = memoryWithSections(6, 1_000)
  await call('projects_memory', { project_id: projectId, action: 'write', text: original })

  // A directory where the archive file belongs makes the archive write fail
  // after the backup was taken — exactly the "half-way through" case.
  await mkdir(join(projectDirOf(projectId), 'memory-archive.md'), { recursive: true })
  const failed = await plugin.compactMemory(projectId)
  assert.equal(failed.skipped, 'error')
  assert.match(failed.reason, /EISDIR|ENOTDIR|EPERM|EACCES|illegal operation/i)
  // The memory was never replaced, and no compaction is recorded.
  assert.equal(await memoryOf(projectId), original)
  assert.equal((await storedProject(projectId)).lastCompaction, undefined)

  // The in-flight flag is gone: once the obstacle is removed the next attempt
  // compacts normally instead of being told a run is still going.
  await rm(join(projectDirOf(projectId), 'memory-archive.md'), { recursive: true, force: true })
  const retried = await plugin.compactMemory(projectId)
  assert.equal(retried.skipped, null)
  assert.ok((await memoryOf(projectId)).length < original.length)
  assert.match(await archiveOf(projectId), /## S1 durable fact/)
})

test('a single oversized section is never split, so nothing is archived', async () => {
  const projectId = await newProject('One section', { memoryBudget: 4_000 })
  const written = await call('projects_memory', {
    project_id: projectId,
    action: 'write',
    text: memoryWithSections(1, 5_000),
  })
  assert.match(written, /nothing safe to archive: a single section is never split/)
  assert.equal(await archiveOf(projectId), '')
  assert.equal((await memoryOf(projectId)).length, 5_000 + '## S1 durable fact\n\n'.length)
})

test('autoCompact false keeps the memory append-only', async () => {
  const projectId = await newProject('Manual memory', { memoryBudget: 4_000, autoCompact: false })
  const original = memoryWithSections(6, 1_000)
  const written = await call('projects_memory', { project_id: projectId, action: 'write', text: original })
  assert.match(written, /Auto-compaction is off for this project/)
  assert.equal(await memoryOf(projectId), original)
  assert.equal(await archiveOf(projectId), '')
  assert.equal((await storedProject(projectId)).lastCompaction, undefined)

  // The coordinator can turn it back on, and the next write compacts.
  const updated = await call('projects_update', { project_id: projectId, autoCompact: true, memoryBudget: 5_000 })
  assert.match(updated, /memory=5000 autoCompact=true/)
  const appended = await call('projects_memory', { project_id: projectId, action: 'append', text: '## S7 later finding\n\nshort' })
  assert.match(appended, /Auto-compacted the shared memory/)
  assert.match(await archiveOf(projectId), /## S1 durable fact/)
})

test('the page memory editor compacts too, and the settings round-trip', async () => {
  const projectId = await newProject('Page memory', { memoryBudget: 4_000 })
  const original = memoryWithSections(6, 1_000)
  const saved = await request('POST', `/projects-api/projects/${projectId}/memory`, { text: original })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.saved, true)
  assert.match(saved.body.compaction, /Auto-compacted the shared memory/)
  assert.match(await archiveOf(projectId), /## S1 durable fact/)

  // The GET still returns the current (compacted) text the editor edits.
  const read = await request('GET', `/projects-api/projects/${projectId}/memory`)
  assert.equal(read.status, 200)
  assert.equal(read.body.memory, await memoryOf(projectId))
  assert.doesNotMatch(read.body.memory, /## S1 durable fact/)

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

test('an archived section is still readable, and the index says so', async () => {
  const projectId = await newProject('Archive reading', { memoryBudget: 4_000 })
  await call('projects_memory', { project_id: projectId, action: 'write', text: memoryWithSections(6, 1_000) })

  // S1 moved out of memory.md, but reading it by title still works and says
  // where it came from.
  const archived = await call('projects_memory', { project_id: projectId, action: 'read', section: 'S1 durable fact' })
  assert.match(archived, /^## S1 durable fact/)
  assert.match(archived, /x{1000}/)
  assert.match(archived, /\(Archived: compaction moved this section out of memory\.md/)

  // A live section is returned without the archive note.
  const live = await call('projects_memory', { project_id: projectId, action: 'read', section: 'S6 durable fact' })
  assert.match(live, /^## S6 durable fact/)
  assert.doesNotMatch(live, /Archived:/)

  // The tool's index lists what was archived, so it stays discoverable...
  const index = await call('projects_memory', { project_id: projectId, action: 'index' })
  assert.match(index, /2 section\(s\), \d+ characters/)
  assert.match(index, /4 archived section\(s\) in memory-archive\.md/)
  assert.match(index, /- S1 durable fact \(\d+ chars\)/)
  assert.ok(index.indexOf('archived section(s)') > index.indexOf('2 section(s)'), 'the live index comes first')
  // ...while the worker prompt's index does not (workers act on current memory).
  const added = await call('projects_add_task', { project_id: projectId, title: 'probe' })
  const taskId = added.match(/t-[0-9a-f]{8}/)[0]
  await call('projects_dispatch', { project_id: projectId, task_id: taskId })
  const prompt = activations[activations.length - 1].prompt[0].text
  assert.match(prompt, /· S6 durable fact — /)
  assert.doesNotMatch(prompt, /S1 durable fact/)
  assert.doesNotMatch(prompt, /memory-archive\.md/)

  // A miss names both stores.
  await assert.rejects(
    () => call('projects_memory', { project_id: projectId, action: 'read', section: 'no such section' }),
    /Archived sections are searchable too/,
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
