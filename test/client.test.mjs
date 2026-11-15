/**
 * Client-half smoke test: load the browser module with a fake module loader,
 * then apply it to a fake Client context and check the two slot contributions.
 *
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
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
