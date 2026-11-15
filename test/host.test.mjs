/**
 * Host-half smoke test: load the plugin with a fake Cordis context, exercise
 * every tool against a temporary DSH_HOME, dispatch a fake worker, settle it,
 * and read the board back through the HTTP route handler.
 *
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

let home
let plugin

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

function createContext() {
  return {
    effect(fn) {
      return fn()
    },
    get(name) {
      return name === 'subagents' ? fakeSubagents : undefined
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

async function request(method, path) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  const res = fakeResponse()
  await routes[0].handler(req, res)
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

  const updated = await call('projects_update_task', {
    project_id: projectId,
    task_id: taskId,
    status: 'done',
    output: 'Three variants delivered.',
  })
  assert.match(updated, /is now done/)
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
