/**
 * The pure edit core: coordinate mapping and every markdown edit the toolbar,
 * the shortcuts and the line-break continuation produce.
 *
 * @module test/core.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadClientHalf } from './harness.mjs'

const core = loadClientHalf().exports.__internals

test('lineBounds covers first, middle and last lines', () => {
  const draft = 'one\ntwo\nthree'
  assert.deepEqual(core.lineBounds(draft, 0), { start: 0, end: 3 })
  assert.deepEqual(core.lineBounds(draft, 5), { start: 4, end: 7 })
  assert.deepEqual(core.lineBounds(draft, draft.length), { start: 8, end: 13 })
  assert.deepEqual(core.lineBounds('', 0), { start: 0, end: 0 })
})

test('chip coordinates round-trip and refuse offsets inside a chip', () => {
  // Draft "@src/app.ts and @README.md", two chips: 12 and 10 clipboard chars.
  const occurrences = [
    { offset: 0, length: 12 },
    { offset: 17, length: 10 },
  ]
  const rows = core.occurrenceIndex(occurrences)
  const detect = '@ and @'
  assert.equal(detect.length, 7)

  // Chip edges and the prose between them map both ways.
  for (const offset of [0, 12, 17, 27]) {
    const folded = core.clipboardToDetect(rows, offset)
    assert.notEqual(folded, null, `clipboard ${offset} maps`)
    assert.equal(core.detectToClipboard(rows, folded), offset)
  }
  // A clipboard offset inside a chip refuses rather than guessing; a detect
  // offset cannot fall inside one (a chip is exactly one U+FFFC), so its only
  // interior-free offsets are the chip's edges.
  assert.equal(core.clipboardToDetect(rows, 1), null)
  assert.equal(core.clipboardToDetect(rows, 18), null)
  assert.equal(core.detectToClipboard(rows, 0), 0, 'chip start')
  assert.equal(core.detectToClipboard(rows, 1), 12, 'chip end is the next boundary')
  assert.equal(core.detectToClipboard(rows, 6), 17, 'second chip start')
  assert.equal(core.detectToClipboard(rows, 7), 27, 'second chip end')
  assert.equal(core.clipboardRangeToDetect(rows, 2, 20), null)
  assert.deepEqual(core.clipboardRangeToDetect(rows, 12, 17), { start: 1, end: 6 })
})

test('inline wrap toggles on, off inside, and off outside', () => {
  const wrap = core.inlineWrapEdit('hello world', 0, 5, '**', '**', 'bold')
  assert.deepEqual(wrap, { start: 0, end: 5, text: '**hello**', caretBack: 0 })

  const unwrapInside = core.inlineWrapEdit('**hello** world', 0, 9, '**', '**', 'bold')
  assert.deepEqual(unwrapInside, { start: 0, end: 9, text: 'hello' })

  const unwrapOutside = core.inlineWrapEdit('**hello** world', 2, 7, '**', '**', 'bold')
  assert.deepEqual(unwrapOutside, { start: 0, end: 9, text: 'hello' })

  const collapsed = core.inlineWrapEdit('', 0, 0, '**', '**', 'bold')
  assert.equal(collapsed.text, '**bold**')
  assert.equal(collapsed.caretBack, 2, 'caret lands before the closing marker')
})

test('line prefix toggles bullets, numbering and headings', () => {
  const bullet = core.LINE_KINDS.bullet
  assert.deepEqual(core.linePrefixEdit('alpha\nbeta', 0, 10, bullet), {
    start: 0,
    end: 10,
    text: '- alpha\n- beta',
  })
  // Toggling the same kind again removes it.
  assert.deepEqual(core.linePrefixEdit('- alpha\n- beta', 0, 14, bullet), {
    start: 0,
    end: 14,
    text: 'alpha\nbeta',
  })
  // Ordered lists number from one and renumber an existing list.
  assert.equal(core.linePrefixEdit('a\nb\nc', 0, 5, core.LINE_KINDS.ordered).text, '1. a\n2. b\n3. c')
  // Indentation survives every kind.
  assert.equal(core.linePrefixEdit('  a', 0, 3, bullet).text, '  - a')
  // A heading replaces an existing block marker rather than stacking.
  assert.equal(core.linePrefixEdit('- a', 0, 3, core.headingKind(2)).text, '## a')
  // A lone blank line (an empty draft) still takes the marker.
  assert.equal(core.linePrefixEdit('', 0, 0, bullet).text, '- ')
  // Blank lines inside a multi-line selection stay untouched.
  assert.equal(core.linePrefixEdit('a\n\nb', 0, 4, bullet).text, '- a\n\n- b')
  // The caret's line is the target when nothing is selected; the edit covers
  // only that line, so the untouched prefix stays out of the replacement.
  assert.deepEqual(core.linePrefixEdit('one\ntwo', 5, 5, core.LINE_KINDS.quote), {
    start: 4,
    end: 7,
    text: '> two',
  })
})

test('fence wraps, unwraps, and seats the caret on an empty body', () => {
  const wrapped = core.fenceEdit('code()', 0, 6, 'js')
  assert.deepEqual(wrapped, { start: 0, end: 6, text: '```js\ncode()\n```', caretBack: 0 })
  assert.equal(core.fenceEdit('```js\ncode()\n```', 0, 15, '').text, 'code()')
  const empty = core.fenceEdit('', 0, 0, '')
  assert.equal(empty.text, '```\n\n```')
  assert.equal(empty.caretBack, 4, 'caret lands on the empty body line')
})

test('link wraps a selection and seeds an empty destination', () => {
  assert.deepEqual(core.linkEdit('docs here', 0, 4, 'label'), {
    start: 0,
    end: 4,
    text: '[docs]()',
    caretBack: 1,
  })
  const collapsed = core.linkEdit('', 0, 0, 'label')
  assert.equal(collapsed.text, '[label]()')
  assert.equal(collapsed.caretBack, 1)
})

test('list continuation recognises every block kind', () => {
  assert.deepEqual(core.listContinuation('- item'), { marker: '- ', exit: false })
  assert.deepEqual(core.listContinuation('* item'), { marker: '* ', exit: false })
  assert.deepEqual(core.listContinuation('  + item'), { marker: '  + ', exit: false })
  assert.deepEqual(core.listContinuation('3) item'), { marker: '4) ', exit: false })
  assert.deepEqual(core.listContinuation('12. item'), { marker: '13. ', exit: false })
  assert.deepEqual(core.listContinuation('- [x] done'), { marker: '- [ ] ', exit: false })
  assert.deepEqual(core.listContinuation('> quote'), { marker: '> ', exit: false })
  // An empty item ends the block instead of continuing it.
  assert.deepEqual(core.listContinuation('- '), { marker: '- ', exit: true })
  assert.deepEqual(core.listContinuation('> '), { marker: '> ', exit: true })
  // Ordinary prose continues nothing.
  assert.equal(core.listContinuation('plain text'), null)
  assert.equal(core.listContinuation('-not a list'), null)
})

test('continuation edits continue a block or drop an empty marker', () => {
  // "- a" + newline, caret at the end: insert the next marker.
  assert.deepEqual(core.continuationEdit('- a\n', 4), { start: 4, end: 4, text: '- ' })
  assert.deepEqual(core.continuationEdit('1. a\n', 5), { start: 5, end: 5, text: '2. ' })
  // "- " + newline: the empty item ends the list, so its marker goes away.
  assert.deepEqual(core.continuationEdit('- \n', 3), { start: 0, end: 2, text: '' })
  // Nothing to do without a trailing line break or without a block.
  assert.equal(core.continuationEdit('- a', 3), null)
  assert.equal(core.continuationEdit('plain\n', 6), null)
})

test('buildEdit routes every action and the shortcut table stays in sync', () => {
  const labels = { bold: 'b', italic: 'i', strike: 's', code: 'c', linkLabel: 'label' }
  assert.equal(core.buildEdit('bold', 'x', 0, 1, labels).text, '**x**')
  assert.equal(core.buildEdit('italic', 'x', 0, 1, labels).text, '*x*')
  assert.equal(core.buildEdit('strike', 'x', 0, 1, labels).text, '~~x~~')
  assert.equal(core.buildEdit('code', 'x', 0, 1, labels).text, '`x`')
  assert.equal(core.buildEdit('link', 'x', 0, 1, labels).text, '[x]()')
  assert.equal(core.buildEdit('h3', 'x', 0, 1, labels).text, '### x')
  assert.equal(core.buildEdit('bullet', 'x', 0, 1, labels).text, '- x')
  assert.equal(core.buildEdit('fence', 'x', 0, 1, labels).text, '```\nx\n```')
  assert.equal(core.buildEdit('nope', 'x', 0, 1, labels), null)

  for (const [combo, name] of core.SHORTCUTS) {
    assert.ok(core.ACTIONS[name] !== undefined, `${combo} maps to a known action`)
    assert.equal(core.ACTIONS[name].shortcut.toLowerCase(), combo)
  }
  assert.equal(core.SHORTCUTS.get('b'), 'bold')
  assert.equal(core.SHORTCUTS.get('shift+x'), 'strike')
  assert.equal(core.SHORTCUTS.get('shift+8'), 'bullet')
})

// ---------------------------------------------------------------------------
// Chip-safe plans: an edit must never replace a reference chip's range, because
// the replacement is plain text and the structured reference would be lost.
// ---------------------------------------------------------------------------

/** Draft "@dsh-markdown-composer/ 说明" as one chip plus trailing prose. */
const chipDraft = 'dsh-markdown-composer/ 说明'
const chipRows = core.occurrenceIndex([{ offset: 0, length: 22 }])
const chipEnd = chipDraft.length

test('chipFree sees only whole-chip intersections', () => {
  assert.equal(core.chipFree(chipRows, 0, chipEnd), false)
  assert.equal(core.chipFree(chipRows, 21, 22), false, 'a partial overlap still counts')
  assert.equal(core.chipFree(chipRows, 22, chipEnd), true, 'text after the chip is free')
  assert.equal(core.chipFree([], 0, 10), true)
})

test('a line-level toggle with a chip prefixes the line instead of rewriting it', () => {
  const plan = core.linePrefixEdits(chipDraft, chipEnd, chipEnd, core.LINE_KINDS.bullet, chipRows)
  assert.deepEqual(plan, [{ start: 0, end: 0, text: '- ' }], 'a collapsed insert at the line start')
  // Without chips the same action stays one atomic edit.
  const atomic = core.linePrefixEdits('说明', 2, 2, core.LINE_KINDS.bullet, [])
  assert.deepEqual(atomic, [{ start: 0, end: 2, text: '- 说明' }])
})

test('unwrapping a line marker with a chip deletes only the marker', () => {
  const marked = `- ${chipDraft}`
  const rows = core.occurrenceIndex([{ offset: 2, length: 22 }])
  const plan = core.linePrefixEdits(marked, marked.length, marked.length, core.LINE_KINDS.bullet, rows)
  assert.deepEqual(plan, [{ start: 0, end: 2, text: '' }])
})

test('an inline wrap with a chip brackets it with collapsed inserts', () => {
  const plan = core.inlineEdits(chipDraft, 0, chipEnd, '**', '**', 'bold', chipRows)
  assert.deepEqual(plan, [
    { start: chipEnd, end: chipEnd, text: '**' },
    { start: 0, end: 0, text: '**' },
  ])
  // A chip-free selection keeps the single atomic wrap.
  assert.deepEqual(core.inlineEdits('hello', 0, 5, '**', '**', 'bold', []), [
    { start: 0, end: 5, text: '**hello**', caretBack: 0 },
  ])
})

test('a fence with a chip adds fence lines around the block', () => {
  const plan = core.fenceEdits(chipDraft, 0, chipEnd, '', chipRows)
  assert.deepEqual(plan, [
    { start: chipEnd, end: chipEnd, text: '\n```' },
    { start: 0, end: 0, text: '```\n' },
  ])
})

test('buildEdits plans chips and refuses an unspellable link label', () => {
  const labels = { bold: 'bold', linkLabel: 'label' }
  assert.equal(core.buildEdits('bold', chipDraft, 0, chipEnd, labels, chipRows).length, 2)
  assert.deepEqual(core.buildEdits('link', chipDraft, 0, chipEnd, labels, chipRows), [])
  assert.equal(core.buildEdits('nope', chipDraft, 0, chipEnd, labels, chipRows).length, 0)
  // `buildEdit` is the chip-free fast path: with no occurrence index it plans
  // the atomic wrap, which is exactly why `runAction` always passes the index.
  assert.equal(core.buildEdit('bold', chipDraft, 0, chipEnd, labels).text, `**${chipDraft}**`)
})

test('shortcut lookup reads physical keys, so Shift+digit works on any layout', () => {
  const ev = (init) => ({ shiftKey: false, altKey: false, key: '', code: '', ...init })
  assert.equal(core.shortcutOf(ev({ code: 'KeyB', key: 'b', metaKey: true })), 'bold')
  assert.equal(core.shortcutOf(ev({ code: 'KeyE', key: 'e', metaKey: true })), 'code')
  // Shift+8 reports key "*" on a US layout: the code still resolves it.
  assert.equal(core.shortcutOf(ev({ code: 'Digit8', key: '*', shiftKey: true, metaKey: true })), 'bullet')
  assert.equal(core.shortcutOf(ev({ code: 'Digit9', key: '(', shiftKey: true, metaKey: true })), 'task')
  assert.equal(core.shortcutOf(ev({ code: 'Digit7', key: '&', shiftKey: true, metaKey: true })), 'ordered')
  assert.equal(core.shortcutOf(ev({ code: 'Period', key: '>', shiftKey: true, metaKey: true })), 'quote')
  assert.equal(core.shortcutOf(ev({ code: 'KeyC', key: 'C', shiftKey: true, metaKey: true })), 'fence')
  // `shortcutOf` maps key + Shift only; the listener is what requires the
  // primary modifier (⌘/Ctrl) before it consults the table.
  assert.equal(core.shortcutOf(ev({ code: 'KeyB', key: 'b' })), 'bold')
  assert.equal(core.shortcutOf(ev({ code: 'KeyQ', key: 'q', metaKey: true })), undefined)
})

test('unwrapping a fence around a chip deletes only the fence lines', () => {
  // "```\n" + chip line + "\n```"
  const block = '```\n' + chipDraft + '\n```'
  const rows = core.occurrenceIndex([{ offset: 4, length: 22 }])
  const plan = core.fenceEdits(block, 0, block.length, '', rows)
  assert.deepEqual(plan, [
    { start: block.length - 4, end: block.length, text: '' },
    { start: 0, end: 4, text: '' },
  ])
  // Applying the plan by hand reconstructs exactly the code body.
  let text = block
  for (const edit of plan) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  assert.equal(text, chipDraft)
})
