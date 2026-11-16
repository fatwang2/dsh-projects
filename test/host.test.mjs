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

function createContext() {
  return {
    effect(fn) {
      return fn()
    },
    get(name) {
      if (name === 'subagents') return fakeSubagents
      if (name === 'llm') return fakeLlm
      if (name === 'agentPresets') return fakePresets
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
  assert.match(prompt, /Only this\./)
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
