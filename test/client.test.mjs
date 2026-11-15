/**
 * Client-half tests: load the browser module with a fake module loader, then
 * apply it to a fake Client context and check the slot contributions, the
 * dictionaries and the task-board contract.
 *
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, test } from 'node:test'

let registration
let plugin

const React = {
  Component: class {
    constructor(props) {
      this.props = props
    }
  },
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: undefined }),
  useCallback: (fn) => fn,
}

function fakeRequire(name) {
  if (name === 'react') return React
  throw new Error(`unexpected require(${JSON.stringify(name)})`)
}

/** Apply the plugin to a fake Client context and collect what it registers. */
function applyWithFakes() {
  const registrations = []
  const dictionaries = []
  const context = {
    effect(fn) {
      return fn()
    },
    get() {
      return undefined
    },
    locale: {
      register(namespace, dicts) {
        dictionaries.push({ namespace, dicts })
        return () => {}
      },
      getLocale() {
        return { active: 'zh' }
      },
    },
    slots: {
      inject(key, callback) {
        assert.ok(
          ['sidebar.panellist', 'main', 'projects.conversation'].includes(key),
          `unexpected slot ${key}`,
        )
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  plugin.apply(context)
  return { registrations, dictionaries }
}

before(async () => {
  globalThis.window = {
    navigator: { language: 'zh-CN' },
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
  }
  await import('../client/index.js')
  assert.ok(registration, 'the module registers itself with __ModuleLoader__')
  plugin = registration.factory(fakeRequire)
})

test('declares the module id and its services', () => {
  assert.equal(registration.id, '@local/dsh-projects')
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'uiWorkspace', 'sessions'])
  assert.equal(typeof plugin.apply, 'function')
})

test('registers the sidebar entry and the main page', () => {
  const { registrations, dictionaries } = applyWithFakes()

  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, 'projects')
  assert.ok(dictionaries[0].dicts.zh && dictionaries[0].dicts.en)

  assert.equal(registrations.length, 3)
  const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.ok(sidebar)
  assert.equal(sidebar.options.id, 'projects')
  assert.equal(sidebar.options.label(), '项目')

  const main = registrations.find((entry) => entry.options.name === 'main')
  assert.ok(main)
  assert.equal(main.options.key, 'projects')
  assert.equal(typeof main.component, 'function')

  const icon = sidebar.component({ size: 20 })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 20)
  assert.equal(icon.props.height, 20)

  const conversation = registrations.find((entry) => entry.options.name === 'projects.conversation')
  assert.ok(conversation)
  assert.equal(typeof conversation.component, 'function')
})

test('both dictionaries carry the same keys and no add-task surface', () => {
  const { registrations, dictionaries } = applyWithFakes()
  const { en, zh } = dictionaries[0].dicts

  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())

  // The add-task entry is gone: no label, no field, no validation message.
  for (const retired of ['addTask', 'taskTitle', 'taskBrief', 'add', 'titleRequired', 'taskAdded']) {
    assert.equal(retired in en, false, `EN still has ${retired}`)
    assert.equal(retired in zh, false, `ZH still has ${retired}`)
  }
  // `done` is no longer a status; completion is the human-owned `resolved`.
  assert.equal('done' in en, false)
  assert.equal('done' in zh, false)

  // The empty state points at the coordinator instead of an inline form.
  assert.match(en.emptyTasks, /coordinator/i)
  assert.match(zh.emptyTasks, /协调者/)

  // The resolve control and the detail labels exist in both languages.
  for (const key of ['resolve', 'unresolve', 'resolvedBadge', 'brief', 'output', 'noBrief', 'noTask']) {
    assert.equal(typeof en[key], 'string', `EN is missing ${key}`)
    assert.equal(typeof zh[key], 'string', `ZH is missing ${key}`)
  }

  // The registered translate() falls through to the key for retired labels,
  // which proves the page can no longer render an add-task button.
  const main = registrations.find((entry) => entry.options.name === 'main')
  const translate = main.component({}).props.translate
  assert.equal(translate('addTask'), 'addTask')
  assert.equal(translate('emptyTasks'), zh.emptyTasks)
  assert.notEqual(translate('resolve'), 'resolve')
})

test('the task list is a read-only row and status is never written', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

  // No add-task handler, state or POST to the tasks route.
  assert.doesNotMatch(source, /\baddTask\b/)
  assert.doesNotMatch(source, /\bshowNewTask\b/)
  assert.doesNotMatch(source, /\bnewTask\b/)

  // Every task write goes through patchTask, and none of them carries a status.
  // The Host rejects any task PATCH field other than `resolved`, so the page
  // must not even try to write `approved` (the coordinator owns that flag).
  const patches = [...source.matchAll(/patchTask\([^)]*\)/g)].map((match) => match[0])
  assert.ok(patches.length >= 1, 'the detail page keeps its resolve control')
  for (const call of patches) {
    assert.doesNotMatch(call, /status/, `a task patch writes status: ${call}`)
    assert.doesNotMatch(call, /approved/, `a task patch writes approved: ${call}`)
  }
  assert.match(source, /toggleResolved[\s\S]{0,120}resolved: !task\.resolved/)

  // Approval has its own narrow Host route: it never rides the task PATCH, and
  // the returned task is folded back into the board.
  assert.match(source, /\/tasks\/\$\{task\.id\}\/approve`/)
  assert.match(source, /approveTask[\s\S]{0,240}method: 'POST'/)
  assert.match(source, /applyTask\(data\.task\)/)

  // The only POST that touches a /tasks path is that approve route, so the page
  // still cannot create work.
  const posts = [...source.matchAll(/api\(([\s\S]{0,160}?)method: 'POST'/g)].map((match) => match[1])
  assert.ok(posts.length >= 1, 'the page still posts somewhere')
  for (const site of posts) {
    if (/\/tasks/.test(site)) assert.match(site, /\/approve/, `POST to a non-approve task route: ${site}`)
  }

  // The retired status is gone from the pills, the groups and the counts line.
  assert.doesNotMatch(source, /['"]done['"]/)
  assert.doesNotMatch(source, /pj-pill-done/)
  assert.doesNotMatch(source, /pj-task-title/)

  // One row = status pill + title + executor name, and nothing else.
  const rowStart = source.indexOf('const renderTask = (task) =>')
  const rowEnd = source.indexOf('const renderTaskDetail', rowStart)
  assert.ok(rowStart > 0 && rowEnd > rowStart, 'renderTask is defined before the detail renderer')
  const row = source.slice(rowStart, rowEnd).split('\n\n')[0]
  assert.match(row, /StatusPill/)
  assert.match(row, /pj-task-name/)
  assert.match(row, /pj-task-worker/)
  assert.doesNotMatch(row, /task\.brief|task\.output|task\.stopReason|'select'|'option'/)
  assert.ok(row.trimEnd().split('\n').length <= 20, 'the row stays short')

  // The detail page never offers a status picker, and it no longer carries the
  // resolve/delete controls at the bottom: resolve moved to the top-right icon
  // button and deletion lives only in the row context menu.
  const detail = source.slice(rowEnd, source.indexOf('const groups =', rowEnd))
  assert.doesNotMatch(detail, /h\(\s*'select'/)
  assert.match(detail, /task\.brief/)
  assert.match(detail, /task\.output/)
  assert.match(detail, /toggleResolved/)
  assert.match(detail, /t\('approve'\)/)
  assert.match(detail, /t\('approvedBadge'\)/)
  assert.match(detail, /ResolveIcon/)
  assert.match(detail, /aria-pressed/)
  assert.doesNotMatch(detail, /deleteTask/)
  assert.doesNotMatch(detail, /t\('deleteConfirm'\)/)
})

test('the row context menu owns resolve and delete', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const menuStart = source.indexOf('const renderTaskMenu')
  const rowStart = source.indexOf('const renderTask = (task) =>')
  assert.ok(menuStart > 0 && rowStart > menuStart, 'the menu renderer precedes the row')
  const menu = source.slice(menuStart, rowStart)

  assert.match(menu, /role: 'menu'/)
  assert.match(menu, /t\('resolve'\)/)
  assert.match(menu, /t\('unresolve'\)/)
  assert.match(menu, /t\('deleteConfirm'\)/)
  assert.match(menu, /deleteTask\(task\.id\)/)
  assert.match(menu, /pj-menu-item pj-danger/)
  // Two-stage delete: the arm must settle before the second click confirms.
  assert.match(menu, /Date\.now\(\) - confirmDeleteAt\.current > 600/)

  // Fixed positioning lives in the stylesheet, so the list's overflow cannot
  // clip the menu.
  assert.match(source, /\.pj-menu\{position:fixed/)
  assert.match(source, /\.pj-menu\{[^}]*z-index/)

  // The row wires the right-click; the handler cancels the native menu.
  const row = source
    .slice(rowStart, source.indexOf('const renderTaskDetail', rowStart))
    .split('\n\n')[0]
  assert.match(row, /onContextMenu/)
  assert.match(row, /openTaskMenu/)
  assert.match(source, /const openTaskMenu[\s\S]{0,400}preventDefault/)

  // Dismissal and boundary handling.
  assert.match(source, /addEventListener\('pointerdown'/)
  assert.match(source, /'Escape'/)
  assert.match(source, /addEventListener\('scroll'/)
  assert.match(source, /addEventListener\('resize'/)
  assert.match(source, /getBoundingClientRect/)
  assert.match(source, /clamp\(menu\.x, MENU_MARGIN/)
})

test('the columns collapse and resize, and the widths persist', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

  // Collapsed rail: a 44px strip that still shows every project by initial.
  assert.match(source, /\.pj-list\.pj-collapsed\{[^}]*44px/)
  assert.match(source, /const renderListRail/)
  assert.match(source, /pj-rail-btn/)
  assert.match(source, /initialOf\(entry\.name\)/)
  assert.match(source, /aria-expanded/)

  // Two native pointer separators, no dependency.
  const separators = [...source.matchAll(/role: 'separator'/g)]
  assert.equal(separators.length, 2, 'one separator between each pair of columns')
  assert.match(source, /'aria-orientation': 'vertical'/)
  assert.match(source, /addEventListener\('pointermove'/)
  assert.match(source, /pointercancel/)
  assert.match(source, /userSelect = 'none'/)
  assert.match(source, /onKeyDown: \(event\) => nudgeWidth/)

  // Preferences are page-local and prefixed.
  assert.match(source, /projects\.\$\{key\}/)
  assert.match(source, /writeStored\('listCollapsed'/)
  assert.match(source, /writeStored\('listWidth'/)
  assert.match(source, /writeStored\('execWidth'/)
  assert.match(source, /readStoredNumber\('listWidth'/)
  assert.match(source, /readStoredNumber\('execWidth'/)

  // Bounds: a 180px floor for the list and half the viewport as the ceiling.
  assert.match(source, /const LIST_MIN = 180/)
  assert.match(source, /const EXEC_MIN = 280/)
  assert.match(source, /Math\.round\(width \* 0\.5\)/)
})

test('the detail column is a plain flex stack with no overlap', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

  // The percentage cap that let the info pane and the conversation collide is
  // gone; the info pane shrinks and scrolls, the conversation keeps a floor.
  assert.doesNotMatch(source, /max-height:52%/)
  assert.match(source, /\.pj-exec-info\{flex:0 1 auto;min-height:0;overflow:auto/)
  assert.match(source, /\.pj-exec-detail\{[^}]*display:flex[^}]*flex-direction:column[^}]*overflow:hidden/)
  assert.match(source, /\.pj-exec-detail > \.pj-chat-body\{flex:1 1 0;min-height:140px\}/)
  // The conversation gets a positioned ancestor, so its own layers stay inside.
  assert.match(source, /\.pj-chat-body\{position:relative/)

  // Both halves are direct children of the detail column: no absolute layer.
  const detailStart = source.indexOf('const renderTaskDetail')
  const detail = source.slice(detailStart, source.indexOf('const groups =', detailStart))
  assert.doesNotMatch(detail, /position: 'absolute'/)
  assert.match(detail, /className: 'pj-exec-info'/)
  assert.match(detail, /className: 'pj-chat-body'/)
})

test('displayed titles are shortened without touching the stored title', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  assert.match(source, /function shortTitle\(text, max = 40\)/)
  assert.match(source, /shortTitle\(execTitle\)/)
  assert.match(source, /title: execTitle/)
  assert.match(source, /\.pj-task-name\{[^}]*overflow:hidden[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/)
  assert.match(source, /\.pj-exec-task\{[^}]*max-width:220px/)
})

test('the coordinator prompt keeps the main conversation short', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const start = source.indexOf('function coordinatorPrompt')
  const end = source.indexOf('function ProjectsIcon', start)
  assert.ok(start > 0 && end > start, 'coordinatorPrompt is followed by the icon')
  const prompt = source.slice(start, end)

  for (const line of [
    '3-5 句',
    '不要复述任务产出',
    '不要罗列已完成任务清单',
    '不要解释你打算怎么做',
    '一次只问必要的问题',
    '3-5 sentences',
    'Do not restate task output',
    'Do not list completed tasks',
    'Do not explain what you are about to do',
    'Ask one necessary question at a time',
  ]) {
    assert.ok(prompt.includes(line), `the prompt is missing: ${line}`)
  }

  // Tool guidance and the task list are still spliced in.
  assert.match(prompt, /projects_add_task/)
  assert.match(prompt, /projects_dispatch/)
  assert.match(prompt, /projects_memory/)
  assert.match(prompt, /taskLines/)
})
