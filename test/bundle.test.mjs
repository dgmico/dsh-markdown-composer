/**
 * Bundle contract: the artifact the Web client loads registers itself, requires
 * only module-table words, and mounts exactly the two slots it documents.
 *
 * @module test/bundle.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { contextStub, loadClientHalf, MODULE_TABLE, requiredSpecifiers, slotStub } from './harness.mjs'

const bundle = loadClientHalf()

test('the bundle registers under the package id', () => {
  assert.equal(bundle.registration.id, 'dsh-markdown-composer')
  assert.equal(typeof bundle.registration.factory, 'function')
})

test('the bundle requires only module-table words', () => {
  const specifiers = requiredSpecifiers(bundle.source)
  assert.ok(specifiers.length > 0, 'the bundle requires something')
  for (const specifier of specifiers) {
    assert.ok(MODULE_TABLE.includes(specifier), `${specifier} is a module-table word`)
  }
  assert.deepEqual(
    specifiers.filter((specifier) => specifier.startsWith('@deepseek-ai/')),
    ['@deepseek-ai/dsh-client-ui-primitives'],
  )
})

test('the plugin exports the cordis face', () => {
  assert.equal(bundle.exports.name, 'markdown-composer')
  assert.deepEqual(bundle.exports.inject, ['slots', 'locale'])
  assert.equal(typeof bundle.exports.apply, 'function')
})

test('apply registers the panel and the composer toggle', () => {
  const slots = slotStub()
  const { context, effects, locales } = contextStub(slots.service)
  bundle.exports.apply(context)

  assert.deepEqual(slots.injected, ['conversation.input.dock', 'conversation.input.left'])
  assert.deepEqual(
    slots.registered.map((entry) => [entry.spec.name, entry.spec.id, entry.spec.order]),
    [
      ['conversation.input.dock', 'markdown-preview', 30],
      ['conversation.input.left', 'markdown-toggle', 30],
    ],
  )
  for (const entry of slots.registered) {
    assert.equal(entry.spec.locale, 'markdown-composer')
    assert.equal(typeof entry.Component, 'function')
  }
  assert.equal(locales.length, 1, 'one locale namespace registered')
  assert.deepEqual(Object.keys(locales[0].dicts).sort(), ['en', 'zh'])
  assert.equal(effects.length, 3, 'locale plus the two slot effects (no styles service here)')
})

test('every localized key exists in both dictionaries', () => {
  const slots = slotStub()
  const { context, locales } = contextStub(slots.service)
  bundle.exports.apply(context)
  const [zh, en] = [locales[0].dicts.zh, locales[0].dicts.en]
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const key of Object.keys(zh)) {
    assert.ok(zh[key].length > 0, `zh.${key} is not empty`)
    assert.ok(en[key].length > 0, `en.${key} is not empty`)
  }
})

test('apply degrades without a slots service', () => {
  const errors = []
  bundle.exports.apply({
    get: () => undefined,
    effect: () => () => {},
    logger: { debug() {}, error: (message) => errors.push(message) },
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /slots service is unavailable/)
})
