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

  // The Threads panel labels exist in both languages, and the old column title
  // is retired along with it.
  for (const key of [
    'threads',
    'searchThreads',
    'collapseAll',
    'expandAll',
    'noMatches',
    'groupRunning',
    'groupReview',
    'groupWaiting',
    'groupIdle',
    'groupResolved',
    'justNow',
  ]) {
    assert.equal(typeof en[key], 'string', `EN is missing ${key}`)
    assert.equal(typeof zh[key], 'string', `ZH is missing ${key}`)
  }
  assert.equal('executors' in en, false, 'the old column title is retired')
  assert.equal('executors' in zh, false, 'the old column title is retired')

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

  // One thread card = group glyph + title line (with a relative time) + a
  // one-line summary + optional chips, and no controls at all.
  const rowStart = source.indexOf('const renderTask = (task) =>')
  const rowEnd = source.indexOf('const renderThreadGroup', rowStart)
  assert.ok(rowStart > 0 && rowEnd > rowStart, 'renderTask is defined before the group renderer')
  const row = source.slice(rowStart, rowEnd).split('\n\n')[0]
  assert.match(row, /ThreadIcon/)
  assert.match(row, /pj-task-name/)
  assert.match(row, /pj-thread-time/)
  assert.match(row, /pj-thread-sub/)
  assert.doesNotMatch(row, /StatusPill/)
  assert.doesNotMatch(row, /task\.brief|task\.output|task\.stopReason|'select'|'option'/)
  assert.ok(row.trimEnd().split('\n').length <= 32, 'the card stays short')
  // The card root is the only button: every action lives in the context menu.
  assert.equal(
    [...row.matchAll(/h\(\s*'button'/g)].length,
    1,
    'the card nests no control',
  )

  // The detail page never offers a status picker, and it no longer carries the
  // resolve/delete controls at the bottom: resolve moved to the top-right icon
  // button and deletion lives only in the row context menu.
  const detail = source.slice(rowEnd, source.indexOf('const groups =', rowEnd))
  // The only select in the detail pane is the read-only task-model picker.
  // There is no status picker: status stays system-owned.
  const selects = [...detail.matchAll(/h\(\s*'select'/g)]
  assert.equal(selects.length, 1, 'the detail pane has exactly one select')
  assert.match(detail, /value: task\.model \|\| ''[\s\S]{0,400}disabled: true/)
  assert.doesNotMatch(detail, /patchTask\([^)]*model/)
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
  assert.match(menu, /pj-menu-item[\s\S]{0,40}pj-danger/)
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

  // Two native pointer separators, no dependency. The menu's own ARIA
  // separator is a different control, so count the resizer handles instead.
  const separators = [...source.matchAll(/className: 'pj-resizer'/g)]
  assert.equal(separators.length, 2, 'one separator between each pair of columns')
  assert.ok(
    [...source.matchAll(/role: 'separator'/g)].length >= 2,
    'both column handles expose the separator role',
  )
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

test('the panel groups threads into five fixed sections in reference order', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const start = source.indexOf('const THREAD_GROUPS')
  const end = source.indexOf('function plainLine', start)
  assert.ok(start > 0 && end > start, 'THREAD_GROUPS is declared before the helpers')
  const block = source.slice(start, end)

  const order = [...block.matchAll(/key: '([a-z]+)'/g)].map((match) => match[1])
  assert.deepEqual(order, ['running', 'review', 'waiting', 'idle', 'resolved'])
  assert.match(block, /statuses: \['running'\]/)
  assert.match(block, /statuses: \['review'\]/)
  assert.match(block, /statuses: \['blocked', 'failed'\]/, 'failed waits on the human too')
  assert.match(block, /statuses: \['queued'\]/)
  assert.match(block, /key: 'resolved', icon: 'none'/, 'Resolved carries no glyph')

  // The human verdict outranks the system state.
  const bucket = source.slice(
    source.indexOf('function threadGroups'),
    source.indexOf('function threadIconOf'),
  )
  assert.match(bucket, /if \(task\.resolved\) \{[\s\S]{0,120}buckets\.get\('resolved'\)\.push\(task\)/)

  // Only Resolved starts folded, and the folded set persists.
  assert.match(source, /const DEFAULT_COLLAPSED = \{ resolved: true \}/)
  assert.match(source, /writeStored\('collapsedGroups'/)
  assert.match(source, /readStored\('collapsedGroups'/)
  assert.match(source, /useState\(readCollapsedGroups\)/)

  // A group header is a button that folds its cards and shows the count.
  assert.match(source, /className: 'pj-group-title'[\s\S]{0,200}'aria-expanded'/)
  assert.match(source, /`\$\{t\(group\.titleKey\)\} · \$\{group\.tasks\.length\}`/)
  assert.match(source, /folded \? null : group\.tasks\.map\(renderTask\)/)
})

test('the subtitle is one plain line from output, then brief, then the status', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const start = source.indexOf('function plainLine')
  const end = source.indexOf('function relativeTime', start)
  assert.ok(start > 0 && end > start)
  const block = source.slice(start, end)

  // Only the first non-empty line, with the lightest markdown noise removed.
  assert.ok(block.includes("value.split('\\n').find((entry) => entry.trim())"))
  assert.ok(block.includes('.replace(/^\\s{0,3}#{1,6}\\s*/, \'\')'))
  assert.ok(block.includes('.replace(/^\\s*[-*+]\\s+/, \'\')'))
  assert.ok(block.includes('.replace(/\\*\\*|__|`/g, \'\')'))

  const subtitle = source.slice(
    source.indexOf('function taskSubtitle'),
    source.indexOf('function relativeTime'),
  )
  assert.ok(
    subtitle.includes('return plainLine(task.output) || plainLine(task.brief) || t(task.status)'),
    'output wins, then brief, then the status label',
  )
})

test('relative times come from the Host stamps and degrade to a date', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const start = source.indexOf('function relativeTime')
  const end = source.indexOf('function taskChips', start)
  assert.ok(start > 0 && end > start)
  const block = source.slice(start, end)

  // The Host stamps createdAt/updatedAt on every task and adds
  // startedAt/finishedAt around a run; the freshest stamp wins.
  assert.ok(
    block.includes(
      'Number(task.finishedAt) || Number(task.updatedAt) || Number(task.createdAt) || 0',
    ),
  )
  assert.match(block, /if \(!stamp\) return ''/, 'an unstamped task shows no time at all')
  assert.match(block, /return t\('justNow'\)/)
  assert.match(block, /\}m`/)
  assert.match(block, /\}h`/)
  assert.match(block, /\}d`/)
  assert.match(block, /toLocaleDateString\(locale, \{ month: 'short', day: 'numeric' \}\)/)
  assert.match(block, /delta < 7 \* day/)
})

test('the threads head carries a live search and a fold-all toggle', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

  // The column is titled Threads, and the detail page returns to it.
  assert.match(source, /t\('threads'\)/)
  assert.doesNotMatch(source, /t\('executors'\)/)

  // Search filters title + summary before the bucketing happens.
  assert.match(source, /className: 'pj-search'/)
  assert.match(source, /placeholder: t\('searchThreads'\)/)
  assert.match(source, /onChange: \(event\) => setQuery\(event\.target\.value\)/)
  assert.match(source, /const needle = query\.trim\(\)\.toLowerCase\(\)/)
  assert.match(source, /`\$\{task\.title \|\| ''\} \$\{taskSubtitle\(task, t\)\}`\.toLowerCase\(\)/)

  // One button flips every group; the label reflects the current state.
  assert.match(source, /allGroupsCollapsed \? t\('expandAll'\) : t\('collapseAll'\)/)
  assert.match(source, /const allGroupsCollapsed = THREAD_GROUPS\.every/)

  // The reference panel's filter/expand/close icons are deliberately absent.
  assert.doesNotMatch(source, /t\('filterThreads'\)/)
  assert.doesNotMatch(source, /t\('closePanel'\)/)
})

test('the concurrency input follows the Host ceiling of eight', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const input = source.slice(source.indexOf("t('concurrency')"), source.indexOf("t('workspace')"))
  assert.match(input, /max: 8,/)
  assert.doesNotMatch(source, /max: 10,/)
})

test('the model pickers read the Host catalog and degrade to free text', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

  // The catalog comes from the Host's read-only route, fetched once. A failed
  // call leaves both controls in their free-text fallback.
  assert.match(source, /api\('\/models'\)/)
  assert.match(source, /enumerable: data\.enumerable === true/)
  assert.match(source, /presetsEnumerable: data\.presetsEnumerable === true/)
  assert.match(source, /Array\.isArray\(data\.models\)/)
  assert.match(source, /Array\.isArray\(data\.presets\)/)

  // Project settings: one select per catalog, each with the empty default
  // option, saving through the existing project PATCH route.
  const settingsStart = source.indexOf('const renderSettings')
  const settingsEnd = source.indexOf('const renderListRail', settingsStart)
  assert.ok(settingsStart > 0 && settingsEnd > settingsStart)
  const settings = source.slice(settingsStart, settingsEnd)
  assert.match(settings, /t\('execution'\)/)
  assert.match(settings, /catalog\.enumerable[\s\S]{0,60}\? h\([\s\S]{0,160}'select'/)
  assert.match(settings, /catalog\.presetsEnumerable[\s\S]{0,60}\? h\([\s\S]{0,160}'select'/)
  assert.match(settings, /patchProject\(\{ model: event\.target\.value \}\)/)
  assert.match(settings, /patchProject\(\{ agentPreset: event\.target\.value \}\)/)
  assert.match(settings, /t\('modelDefault'\)/)

  // Fallback: a free-text field plus a one-line hint.
  assert.match(settings, /defaultValue: project\.model \|\| ''/)
  assert.match(settings, /t\('modelFreeTextHint'\)/)
  assert.match(settings, /defaultValue: project\.agentPreset \|\| ''/)
  assert.match(settings, /t\('presetFreeTextHint'\)/)

  // Detail page: the effective route and its source, plus a read-only override.
  const detailStart = source.indexOf('const renderTaskDetail')
  const detail = source.slice(detailStart, source.indexOf('const groups =', detailStart))
  assert.match(detail, /effectiveModel\(project, task\)/)
  assert.match(detail, /t\('effectiveModel'\)/)
  assert.match(detail, /effective\.source === 'task'[\s\S]{0,80}'fromTask'/)
  assert.match(detail, /'fromProject'/)
  assert.match(detail, /t\('fromHost'\)/)
  assert.match(detail, /t\('taskModelReadonly'\)/)
  assert.match(detail, /h\('option', \{ value: '' \}, t\('modelInheritProject'\)\)/)

  // Precedence is task > project > host, and an unknown stored route is kept
  // visible instead of silently dropped by the picker.
  const helper = source.slice(
    source.indexOf('function modelRouteOf'),
    source.indexOf('function threadGroups'),
  )
  assert.match(helper, /if \(fromTask\) return \{ value: fromTask, source: 'task' \}/)
  assert.match(helper, /if \(fromProject\) return \{ value: fromProject, source: 'project' \}/)
  assert.match(helper, /return \{ value: '', source: 'host' \}/)
  assert.match(helper, /options\.push\(h\('option', \{ key: value, value \}, value\)\)/)

  // Both dictionaries carry the new labels.
  const { dictionaries } = applyWithFakes()
  const { en, zh } = dictionaries[0].dicts
  for (const key of [
    'execution',
    'executionHint',
    'model',
    'agentPreset',
    'modelDefault',
    'modelInheritProject',
    'modelRoutePlaceholder',
    'modelFreeTextHint',
    'presetFreeTextHint',
    'effectiveModel',
    'fromTask',
    'fromProject',
    'fromHost',
    'taskModel',
    'taskModelReadonly',
  ]) {
    assert.equal(typeof en[key], 'string', `EN is missing ${key}`)
    assert.equal(typeof zh[key], 'string', `ZH is missing ${key}`)
  }
})

test('the controls copy the Host primitives instead of importing them', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

  // No Harness Client package is loaded as a module: the markup and CSS are
  // copied into this file, and only the theme tokens are shared.
  assert.doesNotMatch(source, /require\('@deepseek-ai/)
  assert.doesNotMatch(source, /from '@deepseek-ai/)
  assert.equal(source.match(/#[0-9a-fA-F]{3,8}\b/g), null, 'no literal colors')
  assert.equal(source.match(/rgba?\(/g), null, 'no literal colors')

  // The search field is the Host SearchInput: a 32px bordered wrapper that owns
  // the focus ring, with a 16px leading glyph and a borderless input inside.
  const search = source.slice(source.indexOf('.pj-search{'), source.indexOf('.pj-group{'))
  assert.match(search, /height:32px/)
  assert.match(search, /border:\.5px solid var\(--dsw-alias-border-l4\)/)
  assert.match(search, /border-radius:var\(--dsw-radius-md\)/)
  assert.match(search, /\.pj-search:focus-within\{border-color:var\(--dsw-alias-state-business-primary\)\}/)
  assert.match(search, /\.pj-search-icon\{[^}]*width:16px;height:16px/)
  assert.match(search, /\.pj-search input\{[^}]*border:0/)
  assert.match(source, /className: 'pj-search-icon'/)
  assert.match(source, /h\(SearchIcon/)

  // Buttons use the Host Button primitive's sm scale and its three variants,
  // not a pill of our own invention.
  const button = source.slice(source.indexOf('.pj-btn{'), source.indexOf('.pj-icon-btn{'))
  assert.match(button, /height:28px/)
  assert.match(button, /padding:0 10px/)
  assert.match(button, /border-radius:var\(--dsw-radius-sm\)/)
  assert.match(button, /font-size:12px;line-height:18px/)
  assert.match(button, /\.pj-btn:disabled\{cursor:not-allowed;opacity:\.4\}/)
  assert.match(button, /\.pj-btn-primary\{background:var\(--dsw-alias-button-primary-fill\)/)
  assert.match(button, /\.pj-btn-ghost\{background:transparent;box-shadow:none/)
  assert.doesNotMatch(source, /border-radius:16px/, 'the pill buttons are gone')
  assert.doesNotMatch(source, /\.pj-btn-danger/, 'no invented danger variant')

  // The context menu is the Host Menu primitive: an elevated 4px-padded card,
  // 34px rows with a 14px icon seat, a hairline separator and a danger fill.
  const menu = source.slice(source.indexOf('.pj-menu{'), source.indexOf('.pj-badge{'))
  assert.match(menu, /box-shadow:var\(--dsw-elevation-prominent\)/)
  assert.match(menu, /\.pj-menu-item\{[^}]*min-height:34px/)
  assert.match(menu, /\.pj-menu-item\{[^}]*border-radius:var\(--dsw-radius-md\)/)
  assert.match(menu, /\.pj-menu-icon\{[^}]*width:14px;height:14px/)
  assert.match(menu, /\.pj-menu-separator\{height:\.5px/)
  assert.match(menu, /\.pj-menu-item\.pj-danger:hover:not\(:disabled\)[^{]*\{background:var\(--dsw-alias-interactive-bg-hover-danger\)\}/)
  assert.match(source, /className: 'pj-menu-icon'/)
  assert.match(source, /className: 'pj-menu-separator'/)
  assert.match(source, /className: 'pj-menu-label'/)

  // Roving focus inside the menu: arrows, Home and End move the row index and
  // the effect focuses that row, so Enter activates it natively.
  assert.match(source, /event\.key === 'ArrowDown'/)
  assert.match(source, /event\.key === 'ArrowUp'/)
  assert.match(source, /event\.key === 'Home'/)
  assert.match(source, /event\.key === 'End'/)
  assert.match(source, /menuItemRefs\.current\[menuIndex\]/)
  assert.match(source, /node\.focus\(\{ preventScroll: true \}\)/)

  // A native select cannot carry a caret, so every picker sits in a wrapper
  // that draws the Host's 12px chevron in the menu-icon tone.
  const select = source.slice(source.indexOf('.pj-select-wrap{'), source.indexOf('.pj-row{'))
  assert.match(select, /\.pj-select\{[^}]*appearance:none/)
  assert.match(select, /\.pj-select\{[^}]*height:34px/)
  assert.match(select, /\.pj-select-chevron\{[^}]*width:12px;height:12px/)
  assert.match(select, /color:var\(--dsw-alias-menu-icon\)/)
  assert.equal(
    [...source.matchAll(/className: 'pj-select-wrap'/g)].length,
    4,
    'all four pickers are wrapped',
  )
  assert.equal(
    [...source.matchAll(/className: 'pj-select-chevron'/g)].length,
    4,
    'all four pickers draw the caret',
  )

  // Form fields and section rhythm follow the Host settings form.
  assert.match(source, /\.pj-input\{height:34px;padding:0 12px\}/)
  assert.match(source, /\.pj-field\{display:flex;flex-direction:column;gap:6px/)
  assert.match(source, /\.pj-label\{font-size:13px;font-weight:500/)
  assert.match(source, /\.pj-section\{padding:12px 0\}/)
  assert.match(source, /\.pj-section\+\.pj-section\{border-top:\.5px solid var\(--dsw-alias-border-l2\)\}/)
})
