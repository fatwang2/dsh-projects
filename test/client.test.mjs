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

/**
 * The module under test captures this object once, at factory time
 * (`require('react')`), and destructures its hooks. A test that needs working
 * hooks therefore swaps the implementation *behind* the object instead of
 * replacing it: the defaults below are inert, and the element-tree harness
 * installs a real one for its own duration.
 */
const DEFAULT_REACT = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: undefined }),
  useCallback: (fn) => fn,
}

let reactImpl = DEFAULT_REACT

const React = {
  Component: class {
    constructor(props) {
      this.props = props
    }
  },
  createElement: (type, props, ...children) => reactImpl.createElement(type, props, ...children),
  useState: (...args) => reactImpl.useState(...args),
  useEffect: (...args) => reactImpl.useEffect(...args),
  useRef: (...args) => reactImpl.useRef(...args),
  useCallback: (...args) => reactImpl.useCallback(...args),
}

function fakeRequire(name) {
  if (name === 'react') return React
  throw new Error(`unexpected require(${JSON.stringify(name)})`)
}

/**
 * Every slot the plugin contributes to, in declaration order. A booted page has
 * all of them: `sidebar.panellist` (ui-sidebar), `main` (ui-layout),
 * `projects.conversation` (this plugin's own `main` children) and
 * `tool.call.toolview` (ui-tool's `tool-call` entry).
 */
const SLOT_KEYS = ['sidebar.panellist', 'main', 'projects.conversation', 'tool.call.toolview']

/**
 * Apply the plugin to a fake Client context and collect what it registers.
 *
 * The fake `slots` mirrors the real `SlotRegistry`: `inject(key, callback)` runs
 * the callback only while `key` is declared, keeps it pending otherwise, and
 * re-runs it whenever a declaration appears. `undeclared` simulates a page where
 * a contributing package has not registered yet (its slot is not declared).
 */
function applyWithFakes(options = {}) {
  const undeclared = new Set(options.undeclared || [])
  const registrations = []
  const dictionaries = []
  const declared = new Set(SLOT_KEYS.filter((key) => !undeclared.has(key)))
  const pending = new Map(SLOT_KEYS.map((key) => [key, []]))
  const run = (key) => {
    const callbacks = pending.get(key) || []
    pending.set(key, [])
    for (const callback of callbacks) callback()
  }
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
        assert.ok(SLOT_KEYS.includes(key), `unexpected slot ${key}`)
        if (declared.has(key)) callback()
        else pending.get(key).push(callback)
        return () => {}
      },
      register(options, component) {
        // The real registry throws for an undeclared slot; keep that contract so
        // a plugin that registers without `inject` fails here too.
        assert.ok(declared.has(options.name), `slot ${options.name} is not declared`)
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  plugin.apply(context)
  return {
    registrations,
    dictionaries,
    /** Publish a declaration after activation, as a late-activating owner does. */
    declare(key) {
      assert.ok(SLOT_KEYS.includes(key), `unexpected slot ${key}`)
      declared.add(key)
      run(key)
    },
  }
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

  assert.equal(registrations.length, 4)
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

  // The dispatch call gets its own keyed Tool view, so a subtask card appears
  // in the conversation the moment the coordinator dispatches it.
  const dispatch = registrations.find((entry) => entry.options.name === 'tool.call.toolview')
  assert.ok(dispatch, 'the dispatch tool view is registered')
  assert.equal(dispatch.options.key, 'projects_dispatch')
  // The card renders through its own injected `translate`, so it declares no
  // host locale namespace and cannot fail on a missing locale face.
  assert.equal(dispatch.options.locale, undefined)
  assert.equal(typeof dispatch.component, 'function')
  assert.equal(typeof dispatch.options.inject, 'function')
  const injected = dispatch.options.inject()
  assert.equal(typeof injected.translate, 'function')
  assert.equal(typeof injected.activeLocale, 'function')
})

test('the dispatch tool view installs when the tool plugin declares its slot late', () => {
  // Activation order is not guaranteed: this plugin injects `slots` only, so it
  // can apply before `@deepseek-ai/dsh-client-ui-tool` registers the `tool-call`
  // entry that declares `tool.call.toolview`. `ctx.slots.inject` must hold the
  // callback until that declaration exists — the entry is not lost.
  const page = applyWithFakes({ undeclared: ['tool.call.toolview'] })

  assert.equal(page.registrations.length, 3)
  assert.equal(
    page.registrations.some((entry) => entry.options.name === 'tool.call.toolview'),
    false,
    'nothing registers into an undeclared slot',
  )

  page.declare('tool.call.toolview')

  const dispatch = page.registrations.find((entry) => entry.options.name === 'tool.call.toolview')
  assert.ok(dispatch, 'the pending registration installs once the slot is declared')
  assert.equal(dispatch.options.key, 'projects_dispatch')
  assert.equal(typeof dispatch.component, 'function')
})

test('declares the client packages whose slots it occupies', () => {
  // `dsh.client.inject` orders module arrival and composes this plugin under the
  // packages it contributes into. Every slot this plugin registers is owned by
  // one of them, so a missing entry is a composition bug even though
  // `ctx.slots.inject` keeps the registration alive on its own.
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const inject = manifest.dsh.client.inject
  assert.ok(Array.isArray(inject))
  for (const name of [
    '@deepseek-ai/dsh-client-ui-layout', // main
    '@deepseek-ai/dsh-client-ui-sidebar', // sidebar.panellist
    '@deepseek-ai/dsh-client-ui-conversation', // conversation.content (renderFactorySlot)
    '@deepseek-ai/dsh-client-ui-tool', // tool.call.toolview
  ]) {
    assert.ok(inject.includes(name), `dsh.client.inject must list ${name}`)
  }
  assert.equal(manifest.dsh.client.platform, 'web')
})

/**
 * Sample an SVG path into points. Supports the commands the icons use
 * (M/L/H/V/Q/C/Z, absolute and relative) and flattens curves, so the caller can
 * take a real bounding box instead of eyeballing the `d` string.
 */
function pathPoints(d, steps = 40) {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+/g) || []
  const points = []
  let i = 0
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  const num = () => Number(tokens[i++])
  const push = (x, y) => points.push([x, y])

  while (i < tokens.length) {
    const cmd = tokens[i++]
    const rel = cmd === cmd.toLowerCase()
    if (cmd === 'M' || cmd === 'm') {
      const x = num()
      const y = num()
      cx = rel ? cx + x : x
      cy = rel ? cy + y : y
      sx = cx
      sy = cy
      push(cx, cy)
    } else if (cmd === 'L' || cmd === 'l') {
      const x = num()
      const y = num()
      cx = rel ? cx + x : x
      cy = rel ? cy + y : y
      push(cx, cy)
    } else if (cmd === 'H' || cmd === 'h') {
      const x = num()
      cx = rel ? cx + x : x
      push(cx, cy)
    } else if (cmd === 'V' || cmd === 'v') {
      const y = num()
      cy = rel ? cy + y : y
      push(cx, cy)
    } else if (cmd === 'Q' || cmd === 'q') {
      const qx = num()
      const qy = num()
      const x = num()
      const y = num()
      const ctrlX = rel ? cx + qx : qx
      const ctrlY = rel ? cy + qy : qy
      const endX = rel ? cx + x : x
      const endY = rel ? cy + y : y
      for (let s = 1; s <= steps; s++) {
        const t = s / steps
        const mt = 1 - t
        push(
          mt * mt * cx + 2 * mt * t * ctrlX + t * t * endX,
          mt * mt * cy + 2 * mt * t * ctrlY + t * t * endY,
        )
      }
      cx = endX
      cy = endY
    } else if (cmd === 'C' || cmd === 'c') {
      const a = num()
      const b = num()
      const c = num()
      const dd = num()
      const e = num()
      const f = num()
      const x1 = rel ? cx + a : a
      const y1 = rel ? cy + b : b
      const x2 = rel ? cx + c : c
      const y2 = rel ? cy + dd : dd
      const endX = rel ? cx + e : e
      const endY = rel ? cy + f : f
      for (let s = 1; s <= steps; s++) {
        const t = s / steps
        const mt = 1 - t
        push(
          mt ** 3 * cx + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t ** 3 * endX,
          mt ** 3 * cy + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t ** 3 * endY,
        )
      }
      cx = endX
      cy = endY
    } else if (cmd === 'Z' || cmd === 'z') {
      cx = sx
      cy = sy
      push(cx, cy)
    } else {
      throw new Error(`pathPoints cannot read the command ${cmd}`)
    }
  }
  return points
}

/** The ink box of a path: the point box grown by half the stroke on every side. */
function inkBox(d, strokeWidth = 0) {
  const points = pathPoints(d)
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  const pad = strokeWidth / 2
  const minX = Math.min(...xs) - pad
  const maxX = Math.max(...xs) + pad
  const minY = Math.min(...ys) - pad
  const maxY = Math.max(...ys) + pad
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY }
}

/**
 * The boxes an icon file actually draws, so a static asset can be measured
 * instead of eyeballed. Rects come straight from their attributes; paths go
 * through `inkBox`, which flattens curves.
 */
function shapeBoxes(svg) {
  const boxes = []
  for (const match of svg.matchAll(/<(rect|path)\b([^>]*?)\/?>/g)) {
    const attrs = Object.fromEntries(
      [...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((pair) => [pair[1], pair[2]]),
    )
    if (match[1] === 'rect') {
      const x = Number(attrs.x ?? 0)
      const y = Number(attrs.y ?? 0)
      const width = Number(attrs.width)
      const height = Number(attrs.height)
      boxes.push({ minX: x, maxX: x + width, minY: y, maxY: y + height, width, height })
    } else {
      boxes.push(inkBox(attrs.d, Number(attrs['stroke-width'] ?? 0)))
    }
  }
  return boxes
}

test('the sidebar icon is a card stack that fills its 24 grid', () => {
  const { registrations } = applyWithFakes()
  const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist')

  const icon = sidebar.component({ size: 18 })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.viewBox, '0 0 24 24')
  assert.equal(icon.props.width, 18)
  assert.equal(icon.props.height, 18)
  assert.equal(icon.props.fill, 'none')

  // The host passes its own size; our default only covers a missing prop.
  assert.equal(sidebar.component({ size: 16 }).props.width, 16)
  assert.equal(sidebar.component({ size: 16 }).props.height, 16)
  assert.equal(sidebar.component({}).props.width, 18)
  assert.equal(sidebar.component({}).props.height, 18)

  // Three strokes only: two rules over a rounded card body. The retired folder
  // plus check pair is gone, so nothing here can draw a tick.
  assert.equal(icon.children.length, 3)
  for (const child of icon.children) {
    assert.equal(child.type, 'path')
    assert.equal(child.props.stroke, 'currentColor')
    assert.equal(child.props.fill, undefined)
    assert.equal(child.props.strokeLinecap, 'round')
    assert.equal(child.props.strokeLinejoin, 'round')
    assert.ok(
      child.props.strokeWidth >= 1.5 && child.props.strokeWidth <= 2,
      `strokeWidth ${child.props.strokeWidth} matches the host's 1.5-2 range`,
    )
    // A check mark is a bent polyline; the stack is rules plus a rounded rect.
    assert.doesNotMatch(child.props.d, /[Ll]/, `no straight-line tick segment in ${child.props.d}`)
  }

  const strokeWidth = icon.children[0].props.strokeWidth
  const [topRule, bottomRule, card] = icon.children.map((child) => inkBox(child.props.d, strokeWidth))
  const cardOutline = inkBox(icon.children[2].props.d, 0)

  // Every open path is a single horizontal rule; only the card body closes.
  const open = icon.children.filter((child) => !/z/i.test(child.props.d))
  assert.equal(open.length, 2, 'exactly two open paths (the rules)')
  for (const child of open) {
    const ys = new Set(pathPoints(child.props.d).map((point) => point[1]))
    assert.equal(ys.size, 1, `an open path bends in y, so it could be a tick: ${child.props.d}`)
  }
  assert.match(icon.children[2].props.d, /Z$/)

  // Stacked and centred: short rule, long rule, then the card body.
  assert.ok(topRule.maxY < bottomRule.minY, 'the two rules do not touch')
  assert.ok(bottomRule.maxY < card.minY, 'the bottom rule clears the card')
  const centre = (box) => (box.minX + box.maxX) / 2
  for (const box of [topRule, bottomRule, card]) {
    assert.ok(Math.abs(centre(box) - 12) < 0.01, `glyph is centred on x=12, got ${centre(box)}`)
  }
  assert.ok(
    topRule.width < bottomRule.width && bottomRule.width < card.width,
    'short rule over long rule over the wider card',
  )

  // The card's own coordinates sit inside 2..22, like the host grid.
  assert.ok(cardOutline.minX >= 2 && cardOutline.maxX <= 22, `x ink ${cardOutline.minX}..${cardOutline.maxX}`)
  assert.ok(cardOutline.minY >= 2 && cardOutline.maxY <= 22, `y ink ${cardOutline.minY}..${cardOutline.maxY}`)

  // Measured fill of the whole glyph (stroke included) over the rendered size.
  const ink = {
    minX: Math.min(topRule.minX, bottomRule.minX, card.minX),
    maxX: Math.max(topRule.maxX, bottomRule.maxX, card.maxX),
    minY: Math.min(topRule.minY, bottomRule.minY, card.minY),
    maxY: Math.max(topRule.maxY, bottomRule.maxY, card.maxY),
  }
  const fillX = (ink.maxX - ink.minX) / 24
  const fillY = (ink.maxY - ink.minY) / 24
  for (const [axis, fill] of [['x', fillX], ['y', fillY]]) {
    assert.ok(fill >= 0.75 && fill <= 0.9, `${axis} fill ${fill.toFixed(3)} lands in 0.75-0.90`)
  }

  // Nothing spills out of the viewBox once the stroke is drawn.
  assert.ok(ink.minX >= 0 && ink.maxX <= 24, 'no horizontal clipping')
  assert.ok(ink.minY >= 0 && ink.maxY <= 24, 'no vertical clipping')

  // A host-shaped 24-grid glyph (ink 2..22) measures 83.3%; stay within 6pp of it.
  const host = inkBox('M2 4.5Q2 2 4.5 2H19.5Q22 2 22 4.5V19.5Q22 22 19.5 22H4.5Q2 22 2 19.5Z', 0)
  const hostFill = host.width / 24
  assert.ok(
    Math.abs(fillX - hostFill) <= 0.06 && Math.abs(fillY - hostFill) <= 0.06,
    `fill ${fillX.toFixed(3)}x${fillY.toFixed(3)} tracks the host's ${hostFill.toFixed(3)}`,
  )

  // 16px readability: the three horizontal strokes (two rules + the card's top
  // edge) keep at least 2px of clear space edge to edge at the smallest size
  // the sidebar renders, or the stack smears into one blob.
  const scale = 16 / 24
  const centres = [topRule.minY + strokeWidth / 2, bottomRule.minY + strokeWidth / 2, cardOutline.minY]
  const gaps = centres.slice(1).map((y, index) => y - centres[index])
  for (const gap of gaps) {
    const clear = (gap - strokeWidth) * scale
    assert.ok(clear >= 2, `16px clear gap ${clear.toFixed(3)}px is under the 2px floor`)
  }

  // No literal colours sneak into the icon block.
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const start = source.indexOf('function ProjectsIcon')
  const end = source.indexOf('function StatusPill', start)
  const block = source.slice(start, end)
  assert.match(block, /currentColor/)
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/)
  assert.doesNotMatch(block, /\brgba?\(|\bhsla?\(/)
})

test('the market icon is a coloured 36-grid card stack, like the host plugin icons', () => {
  const svg = readFileSync(new URL('../icon.svg', import.meta.url), 'utf8')

  // The market draws this file as <img width="36" height="36"> with
  // object-fit: contain, so a 36 grid renders 1:1 — the same grid every host
  // plugin icon uses. The old 24 grid was drawn up to 36 and looked small.
  assert.match(svg, /viewBox="0 0 36 36"/)
  assert.match(svg, /\bwidth="36"/)
  assert.match(svg, /\bheight="36"/)

  // Coloured fills instead of one neutral stroke: the retired #81858C grey read
  // as smaller and duller than the accent-coloured icons it sits beside. The
  // sidebar glyph stays stroke-only and currentColor, so the two assets are
  // deliberately not the same drawing anymore.
  const fills = [...svg.matchAll(/\bfill="([^"]+)"/g)].map((match) => match[1])
  assert.ok(
    fills.some((fill) => fill !== 'none'),
    `at least one shape is filled, got ${JSON.stringify(fills)}`,
  )
  assert.match(svg, /\bfill="#[0-9a-fA-F]{6}"/, 'a literal host colour fills the glyph')
  assert.doesNotMatch(svg, /#81858C/i, 'the retired neutral grey is gone')
  assert.doesNotMatch(svg, /\bstroke=/, 'the market icon is solid fill, not an outline')

  // Three stacked shapes: short rule, long rule, then the card body.
  const shapes = shapeBoxes(svg)
  assert.equal(shapes.length, 3, 'two rules over one card body')
  const [topRule, bottomRule, card] = shapes
  assert.ok(topRule.maxY < bottomRule.minY, 'the two rules do not touch')
  assert.ok(bottomRule.maxY < card.minY, 'the bottom rule clears the card')
  for (const box of shapes) {
    const centre = (box.minX + box.maxX) / 2
    assert.ok(Math.abs(centre - 18) < 0.01, `glyph is centred on x=18, got ${centre}`)
  }
  assert.ok(
    topRule.width < bottomRule.width && bottomRule.width < card.width,
    'short rule over long rule over the wider card',
  )
  const gapAbove = bottomRule.minY - topRule.maxY
  const gapBelow = card.minY - bottomRule.maxY
  assert.ok(Math.abs(gapAbove - gapBelow) < 0.01, `even spacing: ${gapAbove} vs ${gapBelow}`)

  // Content lives in the host's 6..30 safe area: 24 of 36 units, so the glyph
  // fills 67% of its box and keeps the same optical size as its neighbours.
  const ink = {
    minX: Math.min(...shapes.map((box) => box.minX)),
    maxX: Math.max(...shapes.map((box) => box.maxX)),
    minY: Math.min(...shapes.map((box) => box.minY)),
    maxY: Math.max(...shapes.map((box) => box.maxY)),
  }
  assert.ok(ink.minX >= 6 && ink.maxX <= 30, `x ink ${ink.minX}..${ink.maxX} stays in 6..30`)
  assert.ok(ink.minY >= 6 && ink.maxY <= 30, `y ink ${ink.minY}..${ink.maxY} stays in 6..30`)
  for (const [axis, fill] of [
    ['x', (ink.maxX - ink.minX) / 36],
    ['y', (ink.maxY - ink.minY) / 36],
  ]) {
    assert.ok(fill >= 0.62 && fill <= 0.72, `${axis} fill ${fill.toFixed(3)} lands near 0.67`)
  }

  // No decoration: a flat two-tone glyph, at most one gradient as the host does.
  assert.doesNotMatch(svg, /filter|box-shadow|animation|@keyframes|<animate/i)
  const gradients = [...svg.matchAll(/<linearGradient\b/g)].length
  assert.ok(gradients <= 1, `at most one gradient, got ${gradients}`)
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
  for (const key of ['resolve', 'unresolve', 'resolvedBadge', 'noTask']) {
    assert.equal(typeof en[key], 'string', `EN is missing ${key}`)
    assert.equal(typeof zh[key], 'string', `ZH is missing ${key}`)
  }

  // The detail page became a conversation, so the field-form labels it used to
  // stack (`output` / `stopReason` / the read-only task-model picker) are gone
  // rather than left behind as dead keys.
  for (const retired of ['output', 'noOutput', 'stopReason', 'taskModel', 'taskModelReadonly', 'modelInheritProject']) {
    assert.equal(retired in en, false, `EN still has ${retired}`)
    assert.equal(retired in zh, false, `ZH still has ${retired}`)
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

  // The detail page is a conversation, not a field form: the brief opens it as
  // the message the coordinator sent and the executor Session follows. No
  // picker, and no labelled output/stopReason blocks.
  const detail = source.slice(rowEnd, source.indexOf('const groups =', rowEnd))
  assert.doesNotMatch(detail, /h\(\s*'select'/, 'the detail pane has no picker at all')
  assert.doesNotMatch(detail, /task\.output|task\.stopReason/, 'no field dump of the result')
  assert.doesNotMatch(detail, /t\('output'\)|t\('stopReason'\)|t\('taskModel'\)/)
  // The brief is not repeated above the conversation: the coordinator already
  // pasted it into the worker's prompt, so the Session's first message is it.
  assert.doesNotMatch(detail, /task\.brief/)
  assert.doesNotMatch(detail, /pj-msg/)
  assert.match(detail, /className: 'pj-chat-body'/)
  assert.match(detail, /renderSlot\('projects\.conversation'/)
  assert.doesNotMatch(detail, /deleteTask/)
  assert.doesNotMatch(detail, /t\('deleteConfirm'\)/)

  // The human controls moved up into the column header: the status pill, the
  // resolve icon button and the manual-mode approval gate.
  const header = source.slice(source.indexOf('const groups =', rowEnd))
  assert.match(header, /StatusPill/)
  assert.match(header, /toggleResolved\(execTask\)/)
  assert.match(header, /ResolveIcon/)
  assert.match(header, /aria-pressed/)
  assert.match(header, /t\('approve'\)/)
  assert.match(header, /approveTask\(execTask\)/)
  assert.match(header, /t\('approvedBadge'\)/)
  assert.match(header, /t\('resolvedBadge'\)/)
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
  assert.match(menu, /deleteTask\(task\.id\)/)
  assert.match(menu, /pj-menu-item[\s\S]{0,40}pj-danger/)
  // Two-stage delete: the first press arms, and the second stage is a
  // confirmation with two explicit actions (see the next test). The arm must
  // settle before the second press confirms.
  assert.match(menu, /caption: t\('deleteConfirm'\)/)
  assert.match(menu, /label: t\('deleteOnlyTask'\)/)
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

test('the delete confirmation offers archiving as an explicit second action', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const { dictionaries } = applyWithFakes()
  const { en, zh } = dictionaries[0].dicts

  // Both dictionaries carry the confirmation's wording. The archive action says
  // what it does and, just as important, what it cannot do: DSH has no session
  // delete at all, and archiving frees no disk space.
  for (const key of [
    'deleteConfirm',
    'deleteOnlyTask',
    'deleteOnlyTaskHint',
    'deleteAndArchive',
    'archiveSessionHint',
    'archiveSessionTitle',
    'deleteArchived',
    'archiveRunning',
    'archiveParamRejected',
  ]) {
    assert.equal(typeof en[key], 'string', `EN is missing ${key}`)
    assert.equal(typeof zh[key], 'string', `ZH is missing ${key}`)
  }
  assert.match(zh.deleteOnlyTask, /只删任务/)
  assert.match(zh.deleteAndArchive, /归档/)
  assert.match(zh.archiveSessionHint, /不释放磁盘空间/)
  assert.match(zh.archiveSessionHint, /侧栏/)
  assert.match(en.archiveSessionHint, /disk space/i)
  assert.match(en.archiveSessionHint, /sidebar/i)
  // The action never claims to delete a session: that is not a thing DSH does.
  assert.doesNotMatch(zh.deleteAndArchive, /删除会话/)
  assert.doesNotMatch(en.deleteAndArchive, /delete session/i)
  assert.doesNotMatch(zh.archiveSessionTitle, /删除会话/)
  assert.doesNotMatch(en.archiveSessionTitle, /delete the session/i)

  const menuStart = source.indexOf('const renderTaskMenu')
  const rowStart = source.indexOf('const renderTask = (task) =>')
  assert.ok(menuStart > 0 && rowStart > menuStart, 'the menu renderer precedes the row')
  const menu = source.slice(menuStart, rowStart)

  // The second stage is a confirmation with two buttons, never a checkbox, and
  // the archive action only exists when the task actually has a session.
  assert.match(menu, /const canArchive = Boolean\(task\.childSessionId\)/)
  assert.match(menu, /caption: t\('deleteConfirm'\)/)
  assert.match(menu, /label: t\('deleteOnlyTask'\)/)
  assert.match(menu, /canArchive[\s\S]{0,400}label: t\('deleteAndArchive'\)/)
  assert.match(menu, /hint: t\('archiveSessionHint'\)/)
  assert.match(menu, /title: t\('archiveSessionTitle'\)/)
  assert.doesNotMatch(menu, /type: 'checkbox'|menuitemcheckbox/)
  assert.match(source, /className: 'pj-menu-caption'/)
  assert.match(source, /className: 'pj-menu-hint'/)

  // Only the archive call names the parameter, and it is the supported spelling;
  // the spellings the Host refuses are never sent.
  const deleteStart = source.indexOf('const deleteTask = (taskId, options)')
  const deleteEnd = source.indexOf('// ---', deleteStart)
  assert.ok(deleteStart > 0 && deleteEnd > deleteStart, 'deleteTask was located')
  const flow = source.slice(deleteStart, deleteEnd)
  assert.match(flow, /const query = archive \? '\?session=archive' : ''/)
  assert.match(flow, /tasks\/\$\{taskId\}\$\{query\}`/)
  assert.match(flow, /method: 'DELETE'/)
  for (const refused of ['session=1', 'session=true', 'session=delete', 'session=remove', 'session=yes']) {
    assert.equal(source.includes(refused), false, `the page must never send ${refused}`)
  }

  // A 409 means the worker is still running and a 400 means the request was
  // wrong; both are surfaced, and the board only reloads after a 200 so a
  // failure leaves the task in place.
  assert.match(source, /function taskDeleteFailure\(failure, t, archive\)/)
  assert.match(source, /archive && status === 409\) \{/)
  assert.match(source, /t\('archiveRunning'\)/)
  assert.match(source, /archive && status === 400\) return `\$\{t\('archiveParamRejected'\)\}/)
  assert.match(source, /failure\.status = response\.status/)
  assert.match(flow, /catch \(failure\) \{\s*throw new Error\(taskDeleteFailure\(failure, t, archive\)\)/)
  assert.ok(
    flow.indexOf('await refresh(projectId)') > flow.indexOf('await api('),
    'the board reloads only after the Host answered 200',
  )

  // The new rows are styled from theme tokens only.
  for (const rule of ['.pj-menu-caption', '.pj-menu-text', '.pj-menu-hint']) {
    const at = source.indexOf(`${rule}{`)
    assert.ok(at > 0, `${rule} is styled`)
    const block = source.slice(at, source.indexOf('}', at))
    assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgba?\(/i, `${rule} uses a literal colour`)
  }
  for (const rule of ['.pj-menu-caption', '.pj-menu-hint']) {
    const at = source.indexOf(`${rule}{`)
    assert.match(source.slice(at, source.indexOf('}', at)), /var\(--dsw-alias-label-secondary\)/)
  }
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
  // gone; the brief gives height back and the conversation keeps a floor.
  assert.doesNotMatch(source, /max-height:52%/)
  assert.match(source, /\.pj-exec-detail\{[^}]*display:flex[^}]*flex-direction:column[^}]*overflow:hidden/)
  assert.match(source, /\.pj-exec-detail > \.pj-chat-body\{flex:1 1 0;min-height:140px\}/)
  // The conversation gets a positioned ancestor, so its own layers stay inside.
  assert.match(source, /\.pj-chat-body\{position:relative/)

  // The brief bubble is gone, so the column has exactly one scroll source: the
  // embedded Chat view. The detail column clips instead of scrolling, and it
  // carries no height cap of its own.
  assert.doesNotMatch(source, /\.pj-msg/, 'the brief bubble is retired')
  assert.doesNotMatch(source, /pj-msg-bubble|pj-clamped|pj-msg-toggle/)
  assert.doesNotMatch(source, /\.pj-exec-detail\{[^}]*overflow:auto/)
  assert.doesNotMatch(source, /\.pj-exec-detail\{[^}]*max-height/)
  assert.doesNotMatch(source, /\.pj-exec-detail > \.pj-chat-body\{[^}]*overflow:auto/)
  assert.doesNotMatch(source, /\.pj-exec-detail > \.pj-chat-body\{[^}]*max-height/)
  assert.doesNotMatch(source, /\.pj-exec-info\{/, 'the field pane is gone')

  // The conversation is the detail column's only child: no brief, no absolute
  // layer, nothing that could paint over it.
  const detailStart = source.indexOf('const renderTaskDetail')
  const detail = source.slice(detailStart, source.indexOf('const groups =', detailStart))
  assert.doesNotMatch(detail, /position: 'absolute'/)
  assert.doesNotMatch(detail, /task\.brief/)
  assert.match(detail, /className: 'pj-chat-body'/)
  assert.equal(
    [...detail.matchAll(/className: 'pj-chat-body'/g)].length,
    1,
    'the conversation is the only body block',
  )
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

test('the threads head is two glyphs, and the fold-all action lives in the filter', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

  // The column is titled Threads, and the detail page returns to it.
  assert.match(source, /t\('threads'\)/)
  assert.doesNotMatch(source, /t\('executors'\)/)

  // The head carries a search glyph and a filter glyph, both at the Host's
  // 16px seat, and neither is a text button.
  assert.match(source, /h\(SearchIcon, \{ size: 16 \}\)/)
  assert.match(source, /h\(FilterIcon, \{ size: 16 \}\)/)
  assert.match(source, /t\('searchThreads'\)/)
  assert.match(source, /t\('filterThreads'\)/)
  assert.match(source, /'aria-expanded': searchOpen \? 'true' : 'false'/)
  assert.match(source, /'aria-haspopup': 'menu'/)

  // The 4s poll keeps the panel current, so the refresh control is gone.
  assert.doesNotMatch(source, /t\('refresh'\)/)
  assert.doesNotMatch(source, /refresh: '/)

  // The search field unfolds under the head and still filters title + summary
  // before the bucketing happens.
  assert.match(source, /!execTarget && project && searchOpen/)
  assert.match(source, /className: 'pj-search'/)
  assert.match(source, /placeholder: t\('searchThreads'\)/)
  assert.match(source, /onChange: \(event\) => setQuery\(event\.target\.value\)/)
  assert.match(source, /const needle = query\.trim\(\)\.toLowerCase\(\)/)
  assert.match(source, /`\$\{task\.title \|\| ''\} \$\{taskSubtitle\(task, t\)\}`\.toLowerCase\(\)/)
  // Collapsing the field drops the needle with it.
  assert.match(source, /const toggleSearch = \(\) => \{/)
  assert.match(source, /if \(open\) setQuery\(''\)/)

  // The filter popover is one checkbox row per group plus the fold-all action;
  // the label reflects the current state.
  assert.match(source, /role: 'menuitemcheckbox'/)
  assert.match(source, /checked: !hiddenGroups\[group\.key\]/)
  assert.match(source, /allGroupsCollapsed \? t\('expandAll'\) : t\('collapseAll'\)/)
  assert.match(source, /const allGroupsCollapsed = THREAD_GROUPS\.every/)
  assert.match(source, /const shownGroups = groups\.filter\(/)
  assert.match(source, /!hiddenGroups\[group\.key\]/)
  assert.match(source, /t\('showAllGroups'\)/)

  // The reference panel's close icon is still deliberately absent.
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
  assert.match(settings, /patchProject\(\{ model: event\.target\.value \}\)/)
  assert.match(settings, /patchProject\(\{ reasoningEffort: event\.target\.value \}\)/)
  assert.match(settings, /t\('modelDefault'\)/)
  assert.match(settings, /t\('effortDefault'\)/)

  // Fallback: a free-text field plus a one-line hint.
  assert.match(settings, /defaultValue: project\.model \|\| ''/)
  assert.match(settings, /t\('modelFreeTextHint'\)/)
  assert.match(settings, /defaultValue: effortValue\(project\.reasoningEffort\)/)
  assert.match(settings, /t\('effortFreeTextHint'\)/)

  // The settings section no longer repeats the resolved default in a hint line:
  // the two pickers below it already show the stored values, so the line was
  // pure duplication. The key stays for the detail header's tooltip, which is
  // the one place where the resolved route and its source are worth spelling
  // out.
  assert.doesNotMatch(settings, /t\('effectiveModel'\)/)
  assert.doesNotMatch(settings, /modelLabel\(catalog, project\.model\)/)

  // Detail page: the effective route and its source are the header's one
  // secondary line. The read-only task-model picker went with the field form.
  const detailStart = source.indexOf('const renderTaskDetail')
  const detail = source.slice(detailStart, source.indexOf('const groups =', detailStart))
  assert.doesNotMatch(detail, /h\(\s*'select'/, 'no picker in the conversation view')
  assert.doesNotMatch(detail, /taskModel|modelInheritProject/)
  const headerStart = source.indexOf('const execEffective')
  const header = source.slice(headerStart, source.indexOf('renderTaskMenu()', headerStart))
  assert.match(header, /effectiveModel\(project, execTask\)/)
  assert.match(header, /t\('effectiveModel'\)/)
  assert.match(header, /execEffective\?\.source === 'task'[\s\S]{0,80}'fromTask'/)
  assert.match(header, /'fromProject'/)
  assert.match(header, /t\('fromHost'\)/)
  assert.match(header, /execMeta/)

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
    'reasoningEffort',
    'effortShort',
    'modelDefault',
    'effortDefault',
    'modelRoutePlaceholder',
    'modelFreeTextHint',
    'effortFreeTextHint',
    'effortOff',
    'effortLow',
    'effortHigh',
    'effortMax',
    'effectiveModel',
    'fromTask',
    'fromProject',
    'fromHost',
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

  // The one destructive action has its own variant, and it is built from theme
  // tokens like every other button: a danger hairline, a danger hover fill and
  // a filled confirming state.
  const danger = source.slice(source.indexOf('.pj-btn-danger{'), source.indexOf('.pj-icon-btn{'))
  assert.match(danger, /\.pj-btn-danger\{box-shadow:inset 0 0 0 \.5px var\(--dsw-alias-state-error-primary\)/)
  assert.match(danger, /\.pj-btn-danger:hover:not\(:disabled\)\{background:var\(--dsw-alias-interactive-bg-hover-danger\)\}/)
  assert.match(danger, /\.pj-btn-danger-fill\{background:var\(--dsw-alias-state-error-primary\)/)
  assert.equal(danger.match(/#[0-9a-fA-F]{3,8}\b/g), null)

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
  // Two pickers: the model and the reasoning effort in the settings dialog. The
  // autonomy picker is gone from both dialogs (a project is always created
  // manual and the coordinator can still change it), and the read-only
  // task-model control was retired with the detail field form.
  assert.equal(
    [...source.matchAll(/className: 'pj-select-wrap'/g)].length,
    2,
    'both remaining pickers are wrapped',
  )
  assert.equal(
    [...source.matchAll(/className: 'pj-select-chevron'/g)].length,
    2,
    'both remaining pickers draw the caret',
  )

  // Form fields and section rhythm follow the Host settings form.
  assert.match(source, /\.pj-input\{height:34px;padding:0 12px\}/)
  assert.match(source, /\.pj-field\{display:flex;flex-direction:column;gap:6px/)
  assert.match(source, /\.pj-label\{font-size:13px;font-weight:500/)
  assert.match(source, /\.pj-section\{padding:12px 0\}/)
  assert.match(source, /\.pj-section\+\.pj-section\{border-top:\.5px solid var\(--dsw-alias-border-l2\)\}/)
})

test('the detail page is a conversation that reuses the Host Chat view', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

  // The page never registers its own Conversation or view: it renders the Host
  // factory, which resolves `conversation.view` to the Host's ChatView. That
  // view owns the work-details policy, so `ui-chat`'s transcriptView /
  // collapseTiming / foldedReplies already drive the embedded worker
  // conversation exactly as they drive the main one. Duplicating them here
  // would fork the transcript, so the page must not mention them at all.
  // Comments may name the policy; code must not touch it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /transcriptView|collapseTiming|foldedReplies/)
  assert.doesNotMatch(code, /configForms|'ui-chat'/)
  assert.doesNotMatch(code, /name: 'conversation\.(content|view|session)'/)
  assert.match(source, /renderFactorySlot\(\s*'conversation\.content'/)
  assert.match(source, /slots: \{ views: FixedChatView \}/)
  // FixedChatView only pins the view id; the Host still draws the view.
  assert.match(
    source,
    /function FixedChatView\(props\) \{[\s\S]{0,200}renderSlot\('conversation\.session', \{ view: 'chat' \}\)/,
  )

  // The detail body is the conversation and nothing else: no brief echo, no
  // labelled output / stopReason block and no picker.
  const detailStart = source.indexOf('const renderTaskDetail')
  const detail = source.slice(detailStart, source.indexOf('const groups =', detailStart))
  assert.match(detail, /className: 'pj-exec-detail'/)
  assert.doesNotMatch(detail, /pj-msg|task\.brief|t\('brief'\)|t\('noBrief'\)/)
  assert.match(detail, /renderSlot\('projects\.conversation'/)
  assert.doesNotMatch(detail, /pj-task-output|pj-task-meta|pj-task-head|pj-task-foot/)
  assert.doesNotMatch(detail, /h\(\s*'select'/)
  assert.doesNotMatch(detail, /task\.output|task\.stopReason/)

  // The header owns the state: a status pill, the resolve icon, the approval
  // gate, and one secondary line naming the effective model and the executor.
  const headerStart = source.indexOf('const execEffective')
  const header = source.slice(headerStart, source.indexOf('renderTaskMenu()', headerStart))
  assert.match(header, /className: 'pj-detail-head'/)
  assert.match(header, /className: 'pj-detail-row'/)
  assert.match(header, /StatusPill/)
  assert.match(header, /className: 'pj-detail-meta'/)
  assert.match(header, /className: 'pj-detail-meta-text'/)
  assert.match(header, /execTask\.childName/)
  assert.match(header, /t\('openInWorkspace'\)/)
  assert.match(header, /toggleResolved\(execTask\)/)
  assert.match(header, /approveTask\(execTask\)/)
})

test('the detail page never repeats the brief and has one scroll source', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

  // The coordinator already pastes the brief into the worker's prompt, so the
  // Session's first message *is* the brief. Rendering it again above the
  // conversation would show the same text twice, in a worse format.
  const detailStart = source.indexOf('const renderTaskDetail')
  const detail = source.slice(detailStart, source.indexOf('const groups =', detailStart))
  assert.doesNotMatch(detail, /task\.brief/)
  assert.doesNotMatch(detail, /t\('brief'\)|t\('noBrief'\)/)
  assert.doesNotMatch(detail, /pj-msg/)
  // The conversation is the only body block and the only child of the column.
  assert.equal([...detail.matchAll(/className: 'pj-chat-body'/g)].length, 1)
  assert.doesNotMatch(detail, /h\(\s*'button'/, 'the body carries no control')

  // The fold machinery that existed only for the brief bubble is gone, not
  // orphaned: no helper, no state slot, no CSS, no dictionary keys.
  assert.doesNotMatch(source, /briefNeedsToggle|briefOpenFor|pj-msg-bubble|pj-clamped/)
  assert.doesNotMatch(source, /\.pj-msg\{/)
  for (const retired of ['brief', 'noBrief', 'expandBrief', 'collapseBrief']) {
    const { dictionaries } = applyWithFakes()
    const { en, zh } = dictionaries[0].dicts
    assert.equal(retired in en, false, `EN still has ${retired}`)
    assert.equal(retired in zh, false, `ZH still has ${retired}`)
  }

  // One scroll source: the detail column clips and is not height-capped, and
  // the embedded Chat view keeps its floor and owns the scrollbar.
  assert.doesNotMatch(source, /\.pj-exec-detail\{[^}]*overflow:auto/)
  assert.doesNotMatch(source, /\.pj-exec-detail\{[^}]*max-height/)
  assert.doesNotMatch(source, /\.pj-exec-detail > \.pj-chat-body\{[^}]*overflow:auto/)
  assert.doesNotMatch(source, /\.pj-exec-detail > \.pj-chat-body\{[^}]*max-height/)
  assert.match(source, /\.pj-exec-detail > \.pj-chat-body\{flex:1 1 0;min-height:140px\}/)
  // No other rule scoped to the detail column introduces a scroll region.
  const detailRules = [...source.matchAll(/\n\.pj-(?:exec-detail|detail-[a-z-]+)[^{]*\{[^}]*\}/g)].map(
    (match) => match[0],
  )
  assert.ok(detailRules.length >= 3, 'the detail rules were found')
  for (const rule of detailRules) {
    assert.doesNotMatch(rule, /overflow:auto|max-height/, `unexpected scroll source: ${rule.trim()}`)
  }
})

test('the effort picker follows the catalog and the agent preset left the page', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

  // The Host has no global effort enum — `ReasoningEffortId` is an opaque id
  // declared per adapter — so the generic fallback is the DeepSeek adapter's
  // own set, which is what a bare Host would advertise.
  assert.match(source, /const GENERIC_EFFORTS = \['off', 'low', 'high', 'max'\]/)

  // A catalog entry's own `efforts` win; an unknown route or an empty list
  // falls back, so the picker is never empty.
  const helper = source.slice(
    source.indexOf('function effortValue'),
    source.indexOf('function catalogOptions'),
  )
  assert.match(helper, /Array\.isArray\(found\.efforts\)/)
  assert.match(helper, /if \(entries\.length\) return entries/)
  assert.match(helper, /return GENERIC_EFFORTS\.map/)

  // Precedence is task > project > host, mirroring the model.
  assert.match(helper, /if \(fromTask\) return \{ value: fromTask, source: 'task' \}/)
  assert.match(helper, /if \(fromProject\) return \{ value: fromProject, source: 'project' \}/)
  assert.match(helper, /return \{ value: '', source: 'host' \}/)
  // A stored id the catalog does not advertise stays selectable.
  assert.match(helper, /if \(value && !entries\.some\(\(entry\) => entry\.id === value\)\)/)

  // Settings: the picker sits next to the model, defaults to the empty
  // "follows host" option, and saves through the project PATCH route.
  const settingsStart = source.indexOf('const renderSettings')
  const settings = source.slice(settingsStart, source.indexOf('const renderListRail', settingsStart))
  assert.match(settings, /t\('reasoningEffort'\)/)
  assert.match(settings, /h\('option', \{ value: '' \}, t\('effortDefault'\)\)/)
  assert.match(settings, /effortOptions\(catalog, project\.model, project\.reasoningEffort, t\)/)
  assert.match(settings, /patchProject\(\{ reasoningEffort: event\.target\.value \}\)/)
  assert.match(settings, /t\('effortFreeTextHint'\)/)

  // Detail header: the effort joins the model and the worker on the one
  // secondary line, with its source in the tooltip.
  const headerStart = source.indexOf('const execEffective')
  const header = source.slice(headerStart, source.indexOf('renderTaskMenu()', headerStart))
  assert.match(header, /effectiveEffort\(project, execTask\)/)
  assert.match(header, /effortLabel\(catalog, execEffective\?\.value, execEffort\.value, t\)/)
  assert.match(header, /`\$\{t\('effortShort'\)\}: \$\{execEffortLabel\}`/)
  assert.match(header, /t\('reasoningEffort'\)/)

  // The Agent preset control is gone from the page: no label, no picker, no
  // write. The catalog still fetches `presets` because the Host still stores
  // and dispatches `agentPreset`; only the surface is retired.
  assert.doesNotMatch(source, /t\('agentPreset'\)/)
  assert.doesNotMatch(source, /patchProject\(\{ agentPreset/)
  assert.doesNotMatch(source, /project\.agentPreset/)
  assert.match(source, /presets: Array\.isArray\(data\.presets\) \? data\.presets : \[\]/)
  assert.match(source, /presetsEnumerable: data\.presetsEnumerable === true/)

  const { dictionaries } = applyWithFakes()
  const { en, zh } = dictionaries[0].dicts
  for (const retired of ['agentPreset', 'presetFreeTextHint']) {
    assert.equal(retired in en, false, `EN still has ${retired}`)
    assert.equal(retired in zh, false, `ZH still has ${retired}`)
  }
  for (const key of ['reasoningEffort', 'effortShort', 'effortDefault', 'effortFreeTextHint']) {
    assert.equal(typeof en[key], 'string', `EN is missing ${key}`)
    assert.equal(typeof zh[key], 'string', `ZH is missing ${key}`)
  }
})

test('no user-facing string is hardcoded in English', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

  // Everything the page shows goes through `t()` / `translate()`; the only
  // English left is the dictionary itself, identifiers and CSS.
  const dictStart = source.indexOf('const EN = {')
  const dictEnd = source.indexOf('// ---', source.indexOf('const ZH = {'))
  assert.ok(dictStart > 0 && dictEnd > dictStart, 'the dictionaries were located')
  const rest = source.slice(0, dictStart) + source.slice(dictEnd)
  assert.doesNotMatch(rest, /throw new Error\('[A-Z][a-z]/)
  assert.match(rest, /throw new Error\(t\('sessionUnavailable'\)\)/)
  assert.match(rest, /throw new Error\(translate\('pickerUnavailable'\)\)/)
  assert.match(rest, /translate\('promptRejected'\)/)

  // The dictionaries stay in lockstep: same keys, both sides non-empty.
  const { dictionaries: registered } = applyWithFakes()
  const { en, zh } = registered[0].dicts
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const key of Object.keys(en)) {
    assert.equal(typeof en[key], 'string', `EN ${key} is not a string`)
    assert.equal(typeof zh[key], 'string', `ZH ${key} is not a string`)
    assert.ok(en[key].length > 0, `EN ${key} is empty`)
    assert.ok(zh[key].length > 0, `ZH ${key} is empty`)
  }
})

test('a dispatch call renders a card that opens its task', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const { registrations } = applyWithFakes()
  const main = registrations.find((entry) => entry.options.name === 'main')
  const translate = main.component({}).props.translate
  const dispatch = registrations.find((entry) => entry.options.name === 'tool.call.toolview')
  const row = (props) =>
    dispatch.component({ translate, activeLocale: () => 'zh', ...props })

  const args = (values) => ({ text: (name) => values[name] })
  // The card root is a wrapper that carries its own style block, so the card
  // renders outside the board too; the button is the interactive cell.
  const cardOf = (tree) =>
    tree.children.find((child) => child && child.props && child.props.className === 'pj-dispatch')
  const resultBlock = (text, isError = false) => ({
    content: [{ type: 'text', text }],
    isError,
  })

  // Preparing: the arguments may still be streaming, so the card shows the id
  // it already knows and the queued pill instead of throwing.
  const preparing = row({ phase: 'preparing', block: { args: args({ project_id: 'p1', task_id: 't-1' }) } })
  assert.equal(cardOf(preparing).props.className, 'pj-dispatch')
  assert.equal(cardOf(preparing).props.disabled, false)
  assert.equal(cardOf(preparing).children.length, 3, 'glyph, title, pill — no time without a task')
  assert.equal(cardOf(preparing).children[0].props.kind, 'idle')
  assert.equal(cardOf(preparing).children[1].props.className, 'pj-dispatch-name')
  assert.equal(cardOf(preparing).children[1].children[0], 't-1')
  assert.equal(cardOf(preparing).children[2].props.status, 'queued')

  // A preparing call whose arguments are still empty degrades to the label and
  // is not clickable.
  const empty = row({ phase: 'preparing', block: { args: args({}) } })
  assert.equal(cardOf(empty).props.disabled, true)
  assert.equal(cardOf(empty).children[1].children[0], '派发中…')
  assert.equal(cardOf(empty).children.length, 3)

  // Start: the worker is running.
  const started = row({ phase: 'start', block: { args: args({ project_id: 'p1', task_id: 't-1' }) } })
  assert.equal(cardOf(started).children[0].props.kind, 'spinner')
  assert.equal(cardOf(started).children[2].props.status, 'running')

  // Result: a real dispatch means running; a refusal keeps the task queued; an
  // error means failed. The result text is the only evidence available.
  const dispatched = row({
    phase: 'result',
    block: { ...resultBlock('Dispatched task t-1 to worker w (session s).'), args: args({ project_id: 'p1', task_id: 't-1' }) },
  })
  assert.equal(cardOf(dispatched).children[2].props.status, 'running')
  const refused = row({
    phase: 'result',
    block: {
      ...resultBlock('Task t-1 needs human approval first: project autonomy is "manual".'),
      args: args({ project_id: 'p1', task_id: 't-1' }),
    },
  })
  assert.equal(cardOf(refused).children[2].props.status, 'queued')
  const errored = row({
    phase: 'result',
    block: { ...resultBlock('boom', true), args: args({ project_id: 'p1', task_id: 't-1' }) },
  })
  assert.equal(cardOf(errored).children[2].props.status, 'failed')
  assert.equal(cardOf(errored).children[0].props.kind, 'waiting')

  // Clicking asks the board to open the task; with no board bound (a Session
  // outside the page) it is a silent no-op rather than a crash.
  assert.equal(typeof cardOf(dispatched).props.onClick, 'function')
  assert.doesNotThrow(() => cardOf(dispatched).props.onClick())
  assert.doesNotThrow(() => cardOf(empty).props.onClick())

  // The card is one button with no nested control and no status write.
  const cardStart = source.indexOf('function ProjectsDispatchRow')
  const cardEnd = source.indexOf('/** Contain a failing embedded conversation', cardStart)
  assert.ok(cardStart > 0 && cardEnd > cardStart, 'the card component was located')
  const card = source.slice(cardStart, cardEnd)
  assert.equal([...card.matchAll(/h\(\s*'button'/g)].length, 1, 'the card nests no control')
  assert.doesNotMatch(card, /patchTask|api\(|method: 'PATCH'|method: 'POST'/, 'the card only reads')
  assert.match(card, /requestOpenTask\(projectId, taskId\)/)
  assert.match(card, /useStoreValue\(projectSnapshot\)/)
  assert.match(card, /props\.phase === 'result'/)
  assert.match(card, /typeof args\.text === 'function'/)

  // Registration and the cross-subtree bridge.
  assert.match(source, /ctx\.slots\.inject\('tool\.call\.toolview'/)
  assert.match(source, /key: 'projects_dispatch'/)
  assert.match(source, /openTaskRequest\.subscribe/)
  assert.match(source, /projectSnapshot\.set/)
  assert.match(source, /projectSnapshot\.set\(null\)/, 'the page unbinds the cards on unmount')
  // No Host package is imported and no dependency was added.
  assert.doesNotMatch(source, /from '@deepseek-ai|require\('@deepseek-ai/)

  // The card's styles use theme tokens only.
  const dispatchRules = [...source.matchAll(/\n\.pj-dispatch[^{]*\{[^}]*\}/g)].map((match) => match[0])
  assert.ok(dispatchRules.length >= 4, 'the card rules were found')
  for (const rule of dispatchRules) {
    assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, `literal colour: ${rule.trim()}`)
  }
  assert.match(source, /\.pj-dispatch\{[^}]*--dsw-/)

  // The three new labels exist in both languages.
  const { dictionaries } = applyWithFakes()
  const { en, zh } = dictionaries[0].dicts
  for (const key of ['dispatchCard', 'dispatchPreparing', 'dispatchOpenHint']) {
    assert.equal(typeof en[key], 'string', `EN is missing ${key}`)
    assert.equal(typeof zh[key], 'string', `ZH is missing ${key}`)
  }
})

test('the two project surfaces are Host-shaped dialogs, not page regions', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

  // The old surfaces are gone: no settings tab, no in-page new-project form.
  assert.doesNotMatch(source, /centerView/)
  assert.doesNotMatch(source, /\.pj-new-project\{/)
  assert.doesNotMatch(source, /t\('chatTab'\)/)
  assert.doesNotMatch(source, /t\('settingsTab'\)/)

  // Both dialogs are the same component, and both are mounted from the page.
  // The memory preview and the whole-file editor stack on top of settings, so
  // the page owns four dialogs in one tree.
  assert.match(source, /function Modal\(props\)/)
  assert.equal([...source.matchAll(/h\(Modal, \{/g)].length, 4)
  assert.match(source, /titleId: 'pj-new-project-title'/)
  assert.match(source, /titleId: 'pj-settings-title'/)
  assert.match(source, /titleId: 'pj-memory-preview-title'/)
  assert.match(source, /titleId: 'pj-memory-editor-title'/)

  // Two dialogs can be open at once, so only the innermost layer answers Escape
  // and traps Tab: one Escape must close the preview, not the settings dialog
  // under it.
  assert.match(source, /const MODAL_LAYERS = \[\]/)
  assert.match(source, /if \(MODAL_LAYERS\[MODAL_LAYERS\.length - 1\] !== layer\) return/)
  assert.match(source, /MODAL_LAYERS\.push\(layer\)/)
  assert.match(source, /MODAL_LAYERS\.splice\(at, 1\)/)

  // The Host's dialog contract: a labelled modal dialog with a mask.
  assert.match(source, /role: 'dialog'/)
  assert.match(source, /'aria-modal': 'true'/)
  assert.match(source, /'aria-labelledby': titleId/)
  assert.match(source, /className: 'pj-modal-mask'/)
  assert.match(source, /className: 'pj-modal-root'/)

  // Escape closes, Tab cycles inside, focus moves in and comes back.
  assert.match(source, /if \(event\.key === 'Escape'\) \{/)
  assert.match(source, /if \(event\.key !== 'Tab'\) return/)
  assert.match(source, /const focusable = \[\.\.\.node\.querySelectorAll\(FOCUSABLE\)\]/)
  assert.match(source, /const FOCUSABLE =\s*\n?\s*'button:not\(:disabled\), input:not\(:disabled\)/)
  assert.match(source, /focusWithoutRing\(target\)/)
  assert.match(source, /returnFocusRef/)
  assert.match(source, /data-pj-automatic-focus/)
  assert.match(source, /\[data-pj-modal-autofocus\]/)
  // The page behind the mask does not scroll while a dialog is open.
  assert.match(source, /body\.style\.overflow = 'hidden'/)
  assert.match(source, /body\.style\.overflow = modalSavedOverflow/)

  // The card geometry is the Host Modal primitive's, on theme tokens only.
  const modal = source.slice(source.indexOf('.pj-modal-root{'), source.indexOf('@keyframes pj-modal-enter'))
  assert.match(modal, /\.pj-modal-root\{[^}]*position:fixed[^}]*z-index:1000/)
  assert.match(modal, /\.pj-modal-mask\{[^}]*backdrop-filter:var\(--dsw-mask-blur\)/)
  assert.match(modal, /\.pj-modal-mask:after\{[^}]*background:var\(--dsw-alias-bg-mask-1\)/)
  assert.match(modal, /\.pj-modal-dialog\{[^}]*gap:20px/)
  assert.match(modal, /\.pj-modal-dialog\{[^}]*width:min\(380px,100%\)/)
  assert.match(modal, /\.pj-modal-dialog\{[^}]*border-radius:var\(--dsw-radius-panel\)/)
  assert.match(modal, /\.pj-modal-dialog\{[^}]*background:var\(--dsw-alias-bg-layer-2\)/)
  assert.match(modal, /\.pj-modal-dialog\{[^}]*box-shadow:var\(--dsw-elevation-prominent\)/)
  assert.match(modal, /\.pj-modal-action\{min-width:72px\}/)
  assert.equal(modal.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g), null, 'the dialog carries no literal colour')
})

test('the header triggers are glyphs, and archive moved into the settings dialog', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

  // The list head is a plus glyph plus the Host's panel toggle; the main head is
  // a gear. None of them is a text button any more.
  assert.match(source, /h\(PlusIcon, \{ size: 16 \}\)/)
  assert.match(source, /h\(GearIcon, \{ size: 16 \}\)/)
  assert.match(source, /h\(PanelLeftIcon, \{ size: 16 \}\)/)
  assert.match(source, /h\(PanelLeftIcon, \{ size: 18 \}\)/)
  assert.match(source, /ref: newProjectTrigger/)
  assert.match(source, /ref: settingsTrigger/)
  assert.match(source, /onClick: openNewProject/)
  assert.match(source, /onClick: openSettings/)
  // The rail keeps its narrow strip and still expands from the same glyph.
  assert.match(source, /\.pj-list\.pj-collapsed\{[^}]*44px/)
  assert.match(source, /const renderListRail/)
  assert.doesNotMatch(source, /'«'/)
  assert.doesNotMatch(source, /'»'/)

  // The new-project dialog collects every field the Host's create route takes.
  // Autonomy is not one of them any more: the Host's own default (manual)
  // applies, and the coordinator can still change it later.
  for (const field of ['name', 'goal', 'workspace', 'concurrency']) {
    assert.match(source, new RegExp(`newProject\\.${field}`), `the dialog edits ${field}`)
  }
  assert.doesNotMatch(source, /newProject\.autonomy/)
  assert.doesNotMatch(source, /autonomy: newProject\.autonomy/)
  assert.match(source, /concurrency: Number\(newProject\.concurrency\) \|\| 2/)
  assert.match(source, /const BLANK_PROJECT = \{ name: '', goal: '', workspace: '', concurrency: 2 \}/)

  // Archive is the last thing in the settings dialog, in a danger zone.
  const settings = source.slice(source.indexOf('const renderSettings = () =>'))
  const danger = settings.indexOf("className: 'pj-section pj-danger-zone'")
  assert.ok(danger > 0, 'the danger zone is inside the settings dialog')
  assert.ok(danger > settings.indexOf("t('memory')"), 'the danger zone closes the dialog')
  assert.match(source, /\.pj-section\.pj-danger-zone\{[^}]*border-top:\.5px solid color-mix\(in srgb, var\(--dsw-alias-state-error-primary\)/)
  assert.match(source, /\.pj-section\.pj-danger-zone \.pj-section-title\{color:var\(--dsw-alias-state-error-primary\)\}/)
  assert.match(source, /t\('dangerZone'\)/)
  assert.match(source, /t\('archiveWarning'\)/)

  // Archiving needs two presses: the first only arms it, and the armed dialog
  // refuses to close on a mask press.
  assert.match(source, /const \[archiveArmed, setArchiveArmed\] = useState\(false\)/)
  assert.match(source, /if \(!project\.archived && !archiveArmed\) \{/)
  assert.match(source, /setArchiveArmed\(true\)/)
  assert.match(source, /className: 'pj-btn pj-btn-danger-fill'/)
  assert.match(source, /t\('archiveConfirm'\)/)
  assert.match(source, /maskClose: !archiveArmed/)
  assert.match(source, /onClick: maskClose \? onClose : undefined/)
  // Unarchiving is not destructive, so it stays one press.
  assert.match(source, /project\.archived\s*\n?\s*\? h\(\s*\n?\s*'button'/)

  // The archive action is no longer reachable from the main header.
  const head = source.slice(source.indexOf("className: 'pj-main-head'"), source.indexOf("className: 'pj-main-body'"))
  assert.doesNotMatch(head, /archiveProject/)
  assert.doesNotMatch(head, /t\('archive'\)/)

  // The copy says what archiving costs.
  const { dictionaries } = applyWithFakes()
  const { en, zh } = dictionaries[0].dicts
  for (const key of [
    'settings',
    'close',
    'dangerZone',
    'archiveWarning',
    'archiveConfirm',
    'filterThreads',
    'filterGroups',
    'showAllGroups',
  ]) {
    assert.equal(typeof en[key], 'string', `EN is missing ${key}`)
    assert.equal(typeof zh[key], 'string', `ZH is missing ${key}`)
  }
  assert.match(en.archiveWarning, /hides this project from the list/)
  assert.match(zh.archiveWarning, /从列表中隐藏/)
  // The retired keys are gone from both dictionaries.
  for (const key of ['chatTab', 'settingsTab', 'refresh']) {
    assert.equal(en[key], undefined, `EN still carries ${key}`)
    assert.equal(zh[key], undefined, `ZH still carries ${key}`)
  }
})

// ---------------------------------------------------------------------------
// Element-tree harness
//
// The tests above read the source. These render the real component tree: a tiny
// renderer implements the hook contract the page uses (state with working
// setters, refs, memoised callbacks, effects with deps), expands every function
// component inline, and stubs `fetch` with the Host's `/projects-api` payloads.
// A click is then a real `onClick` call, so what is asserted is the tree the
// browser would paint rather than a substring of the file.

/** Deep equality for a hook's dependency array; no array means "every render". */
function sameDeps(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, index) => Object.is(value, b[index]))
  )
}

const SAMPLE_PROJECT = {
  id: 'p1',
  name: '示例项目',
  goal: '把项目页做成看板',
  workspace: '/Users/wangding/dsh-projects',
  autonomy: 'manual',
  concurrency: 2,
  model: '',
  reasoningEffort: '',
  archived: false,
  coordinatorSessionId: null,
  tasks: [],
}

const SAMPLE_MEMORY = [
  '## 项目背景（2026-11-16）',
  '这个项目是 DSH 的项目看板插件。',
  '',
  '## 已知坑',
  '- 不要碰 host/index.js',
  '- 弹窗要能 Esc 关闭',
].join('\n')

const SAMPLE_MODELS = {
  models: [
    { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', efforts: [{ id: 'low' }, { id: 'high' }] },
  ],
  enumerable: true,
  presets: [],
  presetsEnumerable: false,
}

function createPageHarness({ projects = [], detail = null } = {}) {
  const slots = []
  const cleanups = []
  let cursor = 0
  let pending = []
  let tree = null
  let rendering = false
  let dirty = false
  let root = null

  const flatten = (value, out = []) => {
    if (Array.isArray(value)) {
      for (const entry of value) flatten(entry, out)
    } else if (value !== null && value !== undefined && value !== false && value !== true) {
      out.push(value)
    }
    return out
  }

  /**
   * Render one element. A function component is called inline, while the hook
   * cursor is live, so its hooks land in the same flat slot list on every pass.
   * That is why the tree shape must stay stable — which it does: every dialog
   * renders unconditionally and returns null while closed.
   */
  const expand = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      // `h(Modal, { children, footer })` carries its children in props; a host
      // element carries them as positional arguments.
      const props = node.children.length > 0 ? { ...node.props, children: node.children } : node.props
      return expand(node.type(props))
    }
    return { ...node, children: flatten(node.children).map(expand) }
  }

  const impl = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const at = cursor++
      if (!(at in slots)) {
        slots[at] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = slots[at]
      return [
        slot.value,
        (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next
          if (Object.is(value, slot.value)) return
          slot.value = value
          rerender()
        },
      ]
    },
    useRef(initial) {
      const at = cursor++
      if (!(at in slots)) slots[at] = { kind: 'ref', ref: { current: initial } }
      return slots[at].ref
    },
    useCallback(fn, deps) {
      const at = cursor++
      const slot = slots[at]
      if (slot && slot.kind === 'callback' && sameDeps(slot.deps, deps)) return slot.fn
      slots[at] = { kind: 'callback', fn, deps }
      return fn
    },
    useEffect(fn, deps) {
      const at = cursor++
      const slot = slots[at]
      if (slot && slot.kind === 'effect' && sameDeps(slot.deps, deps)) return
      slots[at] = { kind: 'effect', deps }
      pending.push({ at, fn })
    },
  }

  const flush = () => {
    let guard = 0
    do {
      dirty = false
      cursor = 0
      pending = []
      rendering = true
      tree = expand(root())
      for (const effect of pending) {
        const previous = cleanups[effect.at]
        if (typeof previous === 'function') previous()
        const cleanup = effect.fn()
        cleanups[effect.at] = typeof cleanup === 'function' ? cleanup : undefined
      }
      rendering = false
      guard += 1
      if (guard > 20) throw new Error('the harness re-rendered too many times')
    } while (dirty)
    return tree
  }

  const rerender = () => {
    if (rendering) {
      dirty = true
      return
    }
    flush()
  }

  // The Host's read-only routes, keyed by the path the page asks for.
  const routes = {
    '/projects': { projects },
    '/models': SAMPLE_MODELS,
  }
  if (detail) routes[`/projects/${detail.project.id}`] = detail
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const path = String(url).replace('/projects-api', '')
    const body = routes[path]
    if (body === undefined) return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) }
    return { ok: true, status: 200, json: async () => body }
  }

  const nodes = (from) => {
    const out = []
    const visit = (value) => {
      for (const child of flatten([value])) {
        if (child && typeof child === 'object') {
          out.push(child)
          visit(child.children)
        }
      }
    }
    visit(from === undefined ? tree : from)
    return out
  }

  const textOf = (node) => {
    if (node === null || node === undefined) return ''
    if (typeof node === 'string') return node
    if (typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    if (typeof node !== 'object') return ''
    return flatten(node.children).map(textOf).join('')
  }

  const byClass = (name, from) =>
    nodes(from).filter((node) =>
      String((node.props && node.props.className) || '')
        .split(/\s+/)
        .includes(name),
    )
  const byTag = (type, from) => nodes(from).filter((node) => node.type === type)
  const byLabel = (label, from) =>
    nodes(from).filter((node) => node.props && node.props['aria-label'] === label)
  const byText = (text, from) =>
    nodes(from).filter((node) => node.type === 'button' && textOf(node) === text)
  const byDrag = (from) =>
    nodes(from).filter((node) => node.props && node.props['data-window-drag'])

  return {
    mount(element) {
      // The client destructured its hooks at factory time, so the swap has to
      // happen behind the object it captured (`React` delegates here).
      reactImpl = impl
      root = () => element.type(element.props)
      return flush()
    },
    /** Let the boot fetches and their effects settle. */
    async settle() {
      for (let turn = 0; turn < 4; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      return tree
    },
    unmount() {
      for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup()
      cleanups.length = 0
      globalThis.fetch = originalFetch
      reactImpl = DEFAULT_REACT
    },
    tree: () => tree,
    nodes,
    textOf,
    byClass,
    byTag,
    byLabel,
    byText,
    byDrag,
    click(node) {
      assert.equal(typeof node.props.onClick, 'function', 'the clicked node is a control')
      node.props.onClick({ preventDefault() {}, stopPropagation() {} })
    },
  }
}

/** Mount the real page against the Host's stubbed routes. */
async function mountPage(options) {
  const { registrations } = applyWithFakes()
  const main = registrations.find((entry) => entry.options.name === 'main')
  const page = createPageHarness(options)
  page.mount(main.component({}))
  await page.settle()
  return page
}

test('the workspace is a folder picker in both dialogs, never a text field', async (t) => {
  const page = await mountPage({
    projects: [{ ...SAMPLE_PROJECT }],
    detail: { project: SAMPLE_PROJECT, memory: SAMPLE_MEMORY },
  })
  t.after(() => page.unmount())

  // New project: the plus glyph in the list head opens the dialog.
  page.click(page.byLabel('新建项目')[0])
  const created = page.byClass('pj-modal-dialog')[0]
  assert.ok(created, 'the new-project dialog opened')
  const createdField = page.byClass('pj-field', created).find((node) => page.textOf(node).startsWith('工作区'))
  assert.ok(createdField, 'the dialog has a workspace field')
  assert.equal(
    page.nodes(createdField).filter((node) => node.type === 'input' || node.type === 'textarea').length,
    0,
    'the workspace has no text input',
  )
  const createdPath = page.byClass('pj-path', createdField)
  assert.equal(createdPath.length, 1, 'the chosen path is shown read-only')
  assert.equal(page.textOf(createdPath[0]), '未选择 —— 继承当前会话目录')
  assert.equal(createdPath[0].props.title, '未选择 —— 继承当前会话目录')
  assert.ok(
    page.byText('选择…', createdField).length === 1,
    'the picker is the only way to set the folder',
  )
  // No autonomy control and no duplicated effective-model line anywhere.
  assert.equal(page.byTag('select', created).length, 0, 'the dialog has no picker left but the folder')
  assert.equal(page.byLabel('自主程度', created).length, 0)
  assert.doesNotMatch(page.textOf(created), /自主程度/)
  assert.doesNotMatch(page.textOf(created), /生效模型/)
  page.click(page.byText('取消', created)[0])

  // Settings: the same read-only path, and the stored folder is what it shows.
  page.click(page.byLabel('设置')[0])
  const settings = page.byClass('pj-modal-dialog')[0]
  assert.ok(settings, 'the settings dialog opened')
  const settingsField = page
    .byClass('pj-field', settings)
    .find((node) => page.textOf(node).startsWith('工作区'))
  assert.ok(settingsField, 'the settings dialog has a workspace field')
  assert.equal(
    page.nodes(settingsField).filter((node) => node.type === 'input' || node.type === 'textarea').length,
    0,
    'the workspace has no text input',
  )
  assert.equal(page.textOf(page.byClass('pj-path', settingsField)[0]), SAMPLE_PROJECT.workspace)
  assert.ok(page.byText('选择文件夹', settingsField).length === 1)
  assert.ok(page.byText('清除', settingsField).length === 1, 'a stored folder can be cleared')
  // The autonomy picker is gone; the model and effort pickers remain.
  assert.equal(page.byTag('select', settings).length, 2)
  assert.equal(page.byLabel('自主程度', settings).length, 0)
  assert.doesNotMatch(page.textOf(settings), /自主程度/)
  // The "effective model: … · effort: …" line is gone: it repeated the two
  // pickers directly below it.
  for (const hint of page.byClass('pj-hint', settings)) {
    assert.doesNotMatch(page.textOf(hint), /生效模型/, 'the duplicated default line is gone')
  }
})

test('the settings memory is a section list whose rows open a preview dialog', async (t) => {
  const page = await mountPage({
    projects: [{ ...SAMPLE_PROJECT }],
    detail: { project: SAMPLE_PROJECT, memory: SAMPLE_MEMORY },
  })
  t.after(() => page.unmount())

  page.click(page.byLabel('设置')[0])
  const settings = page.byClass('pj-modal-dialog')[0]
  const rows = page.byClass('pj-memory-row', settings)
  assert.equal(rows.length, 2, 'one row per "## " section')
  assert.equal(page.textOf(page.byClass('pj-memory-row-title', rows[0])[0]), '项目背景（2026-11-16）')
  assert.equal(
    page.textOf(page.byClass('pj-memory-row-desc', rows[0])[0]),
    '这个项目是 DSH 的项目看板插件。',
  )
  const meta = page.textOf(page.byClass('pj-memory-row-meta', rows[0])[0])
  assert.match(meta, /字符/)
  assert.match(meta, /2026-11-16/, 'the date in the title is shown')
  assert.equal(page.textOf(page.byClass('pj-memory-row-title', rows[1])[0]), '已知坑')

  // The whole memory is no longer one textarea in the dialog.
  assert.equal(page.byLabel('共享记忆').length, 0, 'no memory textarea in the settings dialog')

  // A row opens a read-only preview of that section, stacked on the dialog.
  page.click(rows[1])
  const dialogs = page.byClass('pj-modal-dialog')
  assert.equal(dialogs.length, 2, 'the preview stacks on the settings dialog')
  const preview = dialogs[1]
  assert.equal(page.textOf(page.byClass('pj-modal-title', preview)[0]), '已知坑')
  const body = page.textOf(page.byClass('pj-memory-body', preview)[0])
  assert.match(body, /不要碰 host\/index\.js/)
  assert.match(body, /弹窗要能 Esc 关闭/)
  assert.doesNotMatch(body, /项目背景/, 'the preview shows one section, not the file')

  // Closing the preview leaves the settings dialog open.
  page.click(page.byClass('pj-modal-close', preview)[0])
  assert.equal(page.byClass('pj-modal-dialog').length, 1)

  // Editing is still whole-file, behind one explicit entry point.
  page.click(page.byText('编辑全文', settings)[0])
  const editor = page.byClass('pj-modal-dialog')[1]
  assert.ok(editor, 'the editor opened')
  const textarea = page.byTag('textarea', editor).find((node) => node.props['aria-label'] === '共享记忆')
  assert.ok(textarea, 'the editor is the whole memory')
  assert.equal(textarea.props.value, SAMPLE_MEMORY)
  assert.equal(page.byText('保存', editor)[0].props.disabled, true, 'nothing to save yet')
})

test('the page top is a window drag region, the way the Host marks its own', async (t) => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const page = await mountPage({
    projects: [{ ...SAMPLE_PROJECT }],
    detail: { project: SAMPLE_PROJECT, memory: SAMPLE_MEMORY },
  })
  t.after(() => page.unmount())

  // One drag row per column head: the page's whole top strip drags the window.
  const heads = page.byDrag()
  assert.deepEqual(
    heads.map((node) => node.props.className),
    ['pj-list-head', 'pj-main-head', 'pj-exec-head'],
  )

  // The mechanism is the Host frame's, not a private one: its stylesheet turns
  // `data-window-drag` into a draggable region and excludes the buttons inside
  // it, so the plugin declares the region and writes no region CSS of its own.
  assert.doesNotMatch(source, /app-region\s*:/)
  assert.match(source, /'data-window-drag': true/)
  // The controls inside the region still click.
  page.click(page.byLabel('设置')[0])
  assert.equal(page.byClass('pj-modal-dialog').length, 1)
})

test('the two column heads share one height, and the search row clears the divider', () => {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

  // The Threads head is denser than the conversation head, so a bare 56px floor
  // left its divider ~8px above the conversation's once the macOS top clearance
  // was added to each. One floor for both, clearance included.
  assert.match(
    source,
    /\.pj-main-head,\.pj-exec-head\{min-height:calc\(56px \+ var\(--dsh-frame-top-clearance, 0px\)\)\}/,
  )
  assert.doesNotMatch(source, /\.pj-main-head\{[^}]*min-height:56px/)
  assert.doesNotMatch(source, /\.pj-exec-head\{[^}]*min-height:56px/)

  // The search field is no longer flush against the head's bottom border.
  assert.match(source, /\.pj-exec-tools\{[^}]*padding:12px 14px 10px\}/)
})
