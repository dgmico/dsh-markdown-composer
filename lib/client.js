/**
 * Markdown composer — browser half.
 *
 * The DSH composer is a shell-owned Lexical editor: a plugin cannot reach its
 * instance, and replacing it through the `conversation.composer` chain would
 * drop the official attachments, model, permission, plan, slash-command, queue
 * and context-meter UI. This plugin therefore stays additive and lives in the
 * slots the official composer already renders:
 *
 * - `conversation.input.dock` — the live preview panel above the composer card,
 *   rendering the draft through the official `MarkdownText` primitive (the same
 *   GFM + TeX renderer the transcript uses).
 * - `conversation.input.left` — the composer tool-row toggle, which also owns
 *   the document-level keyboard behaviour (markdown shortcuts and list/quote
 *   continuation after a line-break gesture).
 *
 * Every edit goes through the public `inputActions` face (`captureInsertion` +
 * `insertText`), so the shell keeps owning the draft, its revision guard, the
 * undo history and reference chips. Text is edited in *clipboard* coordinates
 * and mapped onto the editor's *detect* coordinates (a reference chip is one
 * U+FFFC there), which is what keeps the toolbar safe in drafts containing
 * `@file` / `/command` chips.
 *
 * Bundle contract: this file is the package's `exports["./client"]`, loaded by
 * the Web client module table and materialized as one lazy CJS factory. It may
 * only require module-table words (react, react/jsx-runtime,
 * @deepseek-ai/dsh-client-ui-primitives, …) — everything else is inlined.
 *
 * @module dsh-markdown-composer/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-markdown-composer',
  factory: (require) => {
    const React = require('react')
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const {
      MarkdownDelegateProvider,
      MarkdownText,
      Tooltip,
      IconChecklistOutlineRegular,
      IconChevronDownOutlineRegular,
      IconChevronUpOutlineRegular,
      IconCodeOutlineRegular,
      IconFlatListOutlineRegular,
      IconLinkOutlineRegular,
    } = primitives

    /** Locale namespace owned by this plugin. */
    const NS = 'markdown-composer'

    /** Preference keys (localStorage; every access is guarded). */
    const PREF_OPEN = 'dsh-markdown-composer.panel'
    const PREF_COLLAPSED = 'dsh-markdown-composer.collapsed'

    // ---------------------------------------------------------------------
    // Pure edit core
    //
    // One edit is `{ start, end, text, caretBack? }` in *clipboard*
    // coordinates: replace [start, end) with `text`. `caretBack` asks the
    // caller to pull the caret back that many characters after the edit lands
    // (the shell puts it at the end of the inserted text).
    // ---------------------------------------------------------------------

    /** Ordered [start, end) from a possibly reversed pair. */
    function ordered(a, b) {
      return a <= b ? [a, b] : [b, a]
    }

    /** Bounds of the line containing `index` (index may equal text.length). */
    function lineBounds(text, index) {
      const at = Math.max(0, Math.min(index, text.length))
      const start = text.lastIndexOf('\n', at - 1) + 1
      const newline = text.indexOf('\n', at)
      return { start, end: newline === -1 ? text.length : newline }
    }

    /**
     * Index the draft's reference chips for coordinate mapping.
     * @param occurrences - chip occurrences in clipboard coordinates, ascending.
     * @returns rows carrying both coordinate systems.
     */
    function occurrenceIndex(occurrences) {
      const rows = []
      let shift = 0
      for (const occ of occurrences ?? []) {
        rows.push({
          clipStart: occ.offset,
          clipEnd: occ.offset + occ.length,
          detect: occ.offset - shift,
          length: occ.length,
        })
        shift += occ.length - 1
      }
      return rows
    }

    /**
     * Fold one clipboard offset onto its detect offset.
     * @returns the detect offset, or null when the offset falls inside a chip.
     */
    function clipboardToDetect(rows, offset) {
      let shift = 0
      for (const row of rows) {
        if (offset >= row.clipEnd) {
          shift += row.length - 1
          continue
        }
        if (offset > row.clipStart) return null
        break
      }
      return offset - shift
    }

    /**
     * Fold one detect offset onto its clipboard offset.
     * @returns the clipboard offset, or null when the offset falls inside a chip.
     */
    function detectToClipboard(rows, offset) {
      let shift = 0
      for (const row of rows) {
        const detectEnd = row.detect + 1
        if (offset >= detectEnd) {
          shift += row.length - 1
          continue
        }
        if (offset > row.detect) return null
        break
      }
      return offset + shift
    }

    /** Map a clipboard range onto the editor's detect coordinates. */
    function clipboardRangeToDetect(rows, start, end) {
      const detectStart = clipboardToDetect(rows, start)
      const detectEnd = clipboardToDetect(rows, end)
      if (detectStart === null || detectEnd === null) return null
      return { start: detectStart, end: detectEnd }
    }

    /**
     * Toggle one inline marker over the selection (wrapping, unwrapping, or
     * inserting an empty pair whose caret lands between the markers).
     * @param draft - clipboard-projection draft.
     * @param selStart - selection start in clipboard coordinates.
     * @param selEnd - selection end in clipboard coordinates.
     * @param open - opening marker.
     * @param close - closing marker.
     * @param placeholder - text inserted for a collapsed selection.
     * @returns the edit, or null when nothing would change.
     */
    function inlineWrapEdit(draft, selStart, selEnd, open, close, placeholder) {
      const [from, to] = ordered(selStart, selEnd)
      const selected = draft.slice(from, to)
      // Wrapped *inside* the selection: unwrap.
      if (
        selected.length >= open.length + close.length &&
        selected.startsWith(open) &&
        selected.endsWith(close)
      ) {
        const inner = selected.slice(open.length, selected.length - close.length)
        return { start: from, end: to, text: inner }
      }
      // Markers sitting immediately outside the selection: unwrap those.
      const outerStart = from - open.length
      const outerEnd = to + close.length
      if (
        outerStart >= 0 &&
        outerEnd <= draft.length &&
        draft.slice(outerStart, from) === open &&
        draft.slice(to, outerEnd) === close
      ) {
        return { start: outerStart, end: outerEnd, text: selected }
      }
      const body = selected.length > 0 ? selected : placeholder
      const text = open + body + close
      // A collapsed selection gets a pair with the caret between the markers.
      return { start: from, end: to, text, caretBack: selected.length > 0 ? 0 : close.length }
    }

    /** Leading block marker grammar shared by every line-level toggle. */
    const BLOCK_MARKER = /^([ \t]*)(?:#{1,6}[ \t]+|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]?)?/

    /**
     * Split a line into its indentation, its block marker (dropped) and text.
     * @param line - one draft line.
     * @returns indentation and remaining text.
     */
    function stripBlockMarker(line) {
      const match = BLOCK_MARKER.exec(line)
      return { indent: match[1], body: line.slice(match[0].length) }
    }

    /** Line-level kinds the toolbar and shortcuts toggle. */
    const LINE_KINDS = {
      bullet: {
        matches: (line) => /^[ \t]*[-*+][ \t]+(?!\[[ xX]\][ \t])/.test(line),
        prefix: (indent) => `${indent}- `,
      },
      ordered: {
        matches: (line) => /^[ \t]*\d+[.)][ \t]+/.test(line),
        prefix: (indent, index) => `${indent}${index + 1}. `,
      },
      task: {
        matches: (line) => /^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/.test(line),
        prefix: (indent) => `${indent}- [ ] `,
      },
      quote: {
        matches: (line) => /^[ \t]*>[ \t]?/.test(line),
        prefix: (indent) => `${indent}> `,
      },
    }

    /** Heading kinds, keyed by level. */
    function headingKind(level) {
      return {
        matches: (line) => new RegExp(`^[ \\t]*#{${level}}[ \\t]`).test(line),
        prefix: (indent) => `${indent}${'#'.repeat(level)} `,
      }
    }

    /**
     * Toggle one line-level marker over every line the selection touches.
     * @param draft - clipboard-projection draft.
     * @param selStart - selection start in clipboard coordinates.
     * @param selEnd - selection end in clipboard coordinates.
     * @param kind - entry of {@link LINE_KINDS} or {@link headingKind}.
     * @returns the edit, or null when nothing would change.
     */
    function linePrefixEdit(draft, selStart, selEnd, kind) {
      const [from, to] = ordered(selStart, selEnd)
      const blockStart = lineBounds(draft, from).start
      const blockEnd = lineBounds(draft, to).end
      const block = draft.slice(blockStart, blockEnd)
      const lines = block.split('\n')
      const marked = lines.filter((line) => line.trim() !== '')
      const allMarked = marked.length > 0 && marked.every((line) => kind.matches(line))
      const onlyBlank = marked.length === 0
      const next = lines.map((line, index) => {
        // Blank lines inside a multi-line selection stay untouched, but a lone
        // blank line (an empty draft, or a fresh line) does take the marker.
        if (line.trim() === '' && !onlyBlank) return line
        const { indent, body } = stripBlockMarker(line)
        return allMarked ? indent + body : kind.prefix(indent, index) + body
      })
      const text = next.join('\n')
      if (text === block) return null
      return { start: blockStart, end: blockEnd, text }
    }

    /**
     * Wrap the touched lines in a fenced code block, or unwrap an existing one.
     * @param draft - clipboard-projection draft.
     * @param selStart - selection start in clipboard coordinates.
     * @param selEnd - selection end in clipboard coordinates.
     * @param lang - fence info string.
     * @returns the edit, or null when nothing would change.
     */
    function fenceEdit(draft, selStart, selEnd, lang) {
      const [from, to] = ordered(selStart, selEnd)
      const blockStart = lineBounds(draft, from).start
      const blockEnd = lineBounds(draft, to).end
      const block = draft.slice(blockStart, blockEnd)
      const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(block)
      if (fenced) return { start: blockStart, end: blockEnd, text: fenced[1] }
      const text = `\`\`\`${lang}\n${block}\n\`\`\``
      return {
        start: blockStart,
        end: blockEnd,
        text,
        // A collapsed selection lands on the empty body line inside the fence.
        caretBack: block === '' ? 4 : 0,
      }
    }

    /**
     * Wrap the selection in a markdown link. A collapsed selection inserts a
     * labelled empty destination with the caret inside the parentheses.
     * @param draft - clipboard-projection draft.
     * @param selStart - selection start in clipboard coordinates.
     * @param selEnd - selection end in clipboard coordinates.
     * @param labelPlaceholder - label used for a collapsed selection.
     * @returns the edit, or null when nothing would change.
     */
    function linkEdit(draft, selStart, selEnd, labelPlaceholder) {
      const [from, to] = ordered(selStart, selEnd)
      const selected = draft.slice(from, to)
      if (selected.length > 0) {
        const text = `[${selected}]()`
        // Caret goes between the parentheses, ready for the destination.
        return { start: from, end: to, text, caretBack: 1 }
      }
      return {
        start: from,
        end: to,
        text: `[${labelPlaceholder}]()`,
        caretBack: 1,
      }
    }

    /**
     * The list/quote marker a line continues, if any.
     * @param line - the line the newline gesture just left.
     * @returns the continuation marker plus whether the item was empty.
     */
    function listContinuation(line) {
      let match
      if ((match = /^([ \t]*)([-*+])[ \t]+\[[ xX]\][ \t]+(.*)$/.exec(line))) {
        return { marker: `${match[1]}${match[2]} [ ] `, exit: match[3].trim() === '' }
      }
      if ((match = /^([ \t]*)([-*+])[ \t]+(.*)$/.exec(line))) {
        return { marker: `${match[1]}${match[2]} `, exit: match[3].trim() === '' }
      }
      if ((match = /^([ \t]*)(\d+)([.)])[ \t]+(.*)$/.exec(line))) {
        return {
          marker: `${match[1]}${Number(match[2]) + 1}${match[3]} `,
          exit: match[4].trim() === '',
        }
      }
      if ((match = /^([ \t]*)>[ \t]?(.*)$/.exec(line))) {
        return { marker: `${match[1]}> `, exit: match[2].trim() === '' }
      }
      return null
    }

    /**
     * The edit a line-break gesture owes the draft: continue a list/quote, or
     * drop the marker of the empty item that ends it.
     * @param draft - clipboard-projection draft.
     * @param caret - caret offset in clipboard coordinates, after the break.
     * @returns the edit, or null when the previous line starts no block.
     */
    function continuationEdit(draft, caret) {
      if (caret <= 0 || caret > draft.length) return null
      if (draft[caret - 1] !== '\n') return null
      const previous = lineBounds(draft, caret - 1)
      const line = draft.slice(previous.start, previous.end)
      const info = listContinuation(line)
      if (info === null) return null
      if (!info.exit) return { start: caret, end: caret, text: info.marker }
      return { start: previous.start, end: previous.end, text: '' }
    }

    /** Every toolbar/shortcut action, in toolbar order. */
    const ACTIONS = {
      bold: { inline: ['**', '**', 'bold'], shortcut: 'B' },
      italic: { inline: ['*', '*', 'italic'], shortcut: 'I' },
      strike: { inline: ['~~', '~~', 'strike'], shortcut: 'Shift+X' },
      code: { inline: ['`', '`', 'code'], shortcut: 'E' },
      link: { shortcut: 'K' },
      h1: { heading: 1, shortcut: 'Shift+1' },
      h2: { heading: 2, shortcut: 'Shift+2' },
      h3: { heading: 3, shortcut: 'Shift+3' },
      bullet: { line: 'bullet', shortcut: 'Shift+8' },
      ordered: { line: 'ordered', shortcut: 'Shift+7' },
      task: { line: 'task', shortcut: 'Shift+9' },
      quote: { line: 'quote', shortcut: 'Shift+.' },
      fence: { fence: true, shortcut: 'Shift+C' },
    }

    // ---------------------------------------------------------------------
    // Chip-safe edit plans
    //
    // A reference chip is one character in detect coordinates but its whole
    // clipboard text in clipboard coordinates, so replacing a range that holds
    // one would replace the structured reference with plain text. Every plan
    // below therefore keeps chip ranges intact: a range holding a chip is never
    // replaced, and the same result is decomposed into collapsed inserts and
    // marker-only deletions instead. Multi-edit plans are ordered back to
    // front, so each edit's offsets still describe the live draft when it runs.
    // ---------------------------------------------------------------------

    /**
     * Whether no reference chip intersects a clipboard range.
     * @param rows - occurrence index.
     * @param start - range start in clipboard coordinates.
     * @param end - range end in clipboard coordinates.
     * @returns true when the range holds no chip.
     */
    function chipFree(rows, start, end) {
      return !rows.some((row) => row.clipStart < end && row.clipEnd > start)
    }

    /**
     * Inline marker edits: one atomic wrap without chips, otherwise collapsed
     * marker inserts (or marker-only deletions when unwrapping).
     * @param draft - clipboard-projection draft.
     * @param selStart - selection start in clipboard coordinates.
     * @param selEnd - selection end in clipboard coordinates.
     * @param open - opening marker.
     * @param close - closing marker.
     * @param placeholder - text used for a collapsed selection.
     * @param rows - occurrence index.
     * @returns the edits to apply, back to front.
     */
    function inlineEdits(draft, selStart, selEnd, open, close, placeholder, rows) {
      const [from, to] = ordered(selStart, selEnd)
      if (chipFree(rows, from, to)) {
        const edit = inlineWrapEdit(draft, from, to, open, close, placeholder)
        return edit === null ? [] : [edit]
      }
      const selected = draft.slice(from, to)
      // Wrapped inside the selection: delete only the two marker runs.
      if (
        selected.length >= open.length + close.length &&
        selected.startsWith(open) &&
        selected.endsWith(close)
      ) {
        return [
          { start: to - close.length, end: to, text: '' },
          { start: from, end: from + open.length, text: '' },
        ]
      }
      // Markers immediately outside the selection: delete those two runs.
      const outerStart = from - open.length
      const outerEnd = to + close.length
      if (
        outerStart >= 0 &&
        outerEnd <= draft.length &&
        draft.slice(outerStart, from) === open &&
        draft.slice(to, outerEnd) === close
      ) {
        return [
          { start: to, end: outerEnd, text: '' },
          { start: outerStart, end: from, text: '' },
        ]
      }
      // Otherwise bracket the selection with collapsed inserts.
      return [
        { start: to, end: to, text: close },
        { start: from, end: from, text: open },
      ]
    }

    /**
     * Line-level edits: one atomic edit without chips, otherwise one surgical
     * edit per line (a collapsed prefix insert, or a marker-only deletion).
     * @param draft - clipboard-projection draft.
     * @param selStart - selection start in clipboard coordinates.
     * @param selEnd - selection end in clipboard coordinates.
     * @param kind - entry of {@link LINE_KINDS} or {@link headingKind}.
     * @param rows - occurrence index.
     * @returns the edits to apply, back to front.
     */
    function linePrefixEdits(draft, selStart, selEnd, kind, rows) {
      const [from, to] = ordered(selStart, selEnd)
      const blockStart = lineBounds(draft, from).start
      const blockEnd = lineBounds(draft, to).end

      if (chipFree(rows, blockStart, blockEnd)) {
        const edit = linePrefixEdit(draft, selStart, selEnd, kind)
        return edit === null ? [] : [edit]
      }

      const lines = draft.slice(blockStart, blockEnd).split('\n')
      const marked = lines.filter((line) => line.trim() !== '')
      const allMarked = marked.length > 0 && marked.every((line) => kind.matches(line))
      const onlyBlank = marked.length === 0
      const edits = []
      let cursor = blockStart
      for (const [index, line] of lines.entries()) {
        const start = cursor
        cursor += line.length + 1
        // Blank lines inside a multi-line selection stay untouched, but a lone
        // blank line (an empty draft, or a fresh line) does take the marker.
        if (line.trim() === '' && !onlyBlank) continue
        if (allMarked) {
          const { indent, body } = stripBlockMarker(line)
          const removed = line.length - indent.length - body.length
          if (removed > 0) edits.push({ start, end: start + removed, text: '' })
        } else {
          const { indent } = stripBlockMarker(line)
          edits.push({ start, end: start, text: kind.prefix(indent, index) })
        }
      }
      return edits.reverse()
    }

    /**
     * Fence edits: one atomic wrap without chips, otherwise fence-line inserts
     * around the block (or fence-line deletions when unwrapping).
     * @param draft - clipboard-projection draft.
     * @param selStart - selection start in clipboard coordinates.
     * @param selEnd - selection end in clipboard coordinates.
     * @param lang - fence info string.
     * @param rows - occurrence index.
     * @returns the edits to apply, back to front.
     */
    function fenceEdits(draft, selStart, selEnd, lang, rows) {
      const [from, to] = ordered(selStart, selEnd)
      const blockStart = lineBounds(draft, from).start
      const blockEnd = lineBounds(draft, to).end
      const block = draft.slice(blockStart, blockEnd)
      if (chipFree(rows, blockStart, blockEnd)) {
        const edit = fenceEdit(draft, from, to, lang)
        return edit === null ? [] : [edit]
      }
      const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(block)
      if (fenced !== null) {
        // Delete the opening fence line and the closing fence (with the
        // newline in front of it) instead of replacing the whole block, so a
        // chip inside the code body survives the unwrap.
        const closeStart = block.lastIndexOf('\n')
        const openEnd = block.indexOf('\n') + 1
        return [
          { start: blockStart + closeStart, end: blockEnd, text: '' },
          { start: blockStart, end: blockStart + openEnd, text: '' },
        ]
      }
      return [
        { start: blockEnd, end: blockEnd, text: '\n```' },
        { start: blockStart, end: blockStart, text: `\`\`\`${lang}\n` },
      ]
    }

    /**
     * Build the edits one action owes the draft.
     * @param name - action name.
     * @param draft - clipboard-projection draft.
     * @param from - selection start in clipboard coordinates.
     * @param to - selection end in clipboard coordinates.
     * @param labels - localized placeholders.
     * @param rows - occurrence index.
     * @returns the edits to apply, back to front.
     */
    function buildEdits(name, draft, from, to, labels, rows) {
      const action = ACTIONS[name]
      if (action === undefined) return []
      if (action.inline !== undefined) {
        const [open, close, key] = action.inline
        return inlineEdits(draft, from, to, open, close, labels[key] ?? key, rows)
      }
      if (action.heading !== undefined) {
        return linePrefixEdits(draft, from, to, headingKind(action.heading), rows)
      }
      if (action.line !== undefined) {
        return linePrefixEdits(draft, from, to, LINE_KINDS[action.line], rows)
      }
      if (action.fence === true) return fenceEdits(draft, from, to, '', rows)
      if (name === 'link') {
        // A link label holding a chip has no chip-safe spelling; refuse it.
        if (!chipFree(rows, from, to)) return []
        const edit = linkEdit(draft, from, to, labels.linkLabel)
        return edit === null ? [] : [edit]
      }
      return []
    }

    /** Keyboard lookup: `<mod>[+shift]+<key>` → action name. */
    const SHORTCUTS = (() => {
      const table = new Map()
      for (const [name, action] of Object.entries(ACTIONS)) {
        if (action.shortcut === undefined) continue
        table.set(action.shortcut.toLowerCase(), name)
      }
      return table
    })()

    /** Whether the primary modifier renders as ⌘. */
    const MAC = (() => {
      const platform = typeof navigator === 'undefined' ? '' : `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`
      return /Mac|iPhone|iPad/.test(platform)
    })()

    /**
     * Render one action shortcut as keycap labels, following the shared
     * shortcut convention (⌘/⇧ on macOS, plus-separated modifiers elsewhere).
     * @param combo - action shortcut, e.g. `B` or `Shift+X`.
     * @returns the keycap labels.
     */
    function shortcutKeycaps(combo) {
      const parts = combo.split('+')
      const labels = [MAC ? '⌘' : 'Ctrl']
      for (const part of parts) {
        labels.push(part === 'Shift' ? (MAC ? '⇧' : 'Shift') : part)
      }
      return MAC
        ? labels
        : labels.flatMap((label, index) => (index === 0 ? [label] : ['+', label]))
    }

    /** Marks an event already handled by one mounted toggle. */
    const HANDLED = Symbol('markdown-composer:handled')

    /**
     * Build the single edit one action owes a chip-free draft: the fast path
     * the tests pin down. `buildEdits` is the general plan builder.
     * @param name - action name.
     * @param draft - clipboard-projection draft.
     * @param from - selection start in clipboard coordinates.
     * @param to - selection end in clipboard coordinates.
     * @param labels - localized placeholders.
     * @returns the edit, or null when the action does not apply atomically.
     */
    function buildEdit(name, draft, from, to, labels) {
      const edits = buildEdits(name, draft, from, to, labels, [])
      return edits.length === 1 ? edits[0] : null
    }

    // ---------------------------------------------------------------------
    // Edit application (the only place the shell's input face is touched)
    // ---------------------------------------------------------------------

    /**
     * Apply one clipboard-coordinate edit through the public input face.
     * @param api - live input api (`inputActions`, `draft`, `occurrences`).
     * @param edit - the edit to apply.
     * @returns whether the shell accepted the edit.
     */
    function applyEdit(api, edit) {
      if (edit === null || api === undefined || api.inputActions === undefined) return false
      const rows = occurrenceIndex(api.occurrences)
      const span = clipboardRangeToDetect(rows, edit.start, edit.end)
      if (span === null) return false
      const live = api.inputActions.captureInsertion()
      if (live === undefined) return false
      const applied = api.inputActions.insertText(edit.text, {
        start: span.start,
        end: span.end,
        draftRev: live.draftRev,
      })
      if (applied && edit.caretBack > 0) placeCaret(api.inputActions, edit.caretBack)
      return applied
    }

    /**
     * Pull the caret back inside freshly inserted markers. The shell leaves the
     * caret after the inserted text, so an empty collapsed insertion of the
     * same offset re-seats the selection without touching the draft.
     * @param inputActions - the shell's stable input actions.
     * @param back - characters to move back from the caret.
     */
    function placeCaret(inputActions, back) {
      try {
        const live = inputActions.captureInsertion()
        const at = Math.max(0, live.start - back)
        inputActions.insertText('', { start: at, end: at, draftRev: live.draftRev })
      } catch {
        /* best effort: a caret that cannot move still leaves valid text */
      }
    }

    /** The live selection in clipboard coordinates, or null. */
    function liveSelection(api) {
      if (api === undefined || api.inputActions === undefined) return null
      const live = api.inputActions.captureInsertion()
      if (live === undefined) return null
      const rows = occurrenceIndex(api.occurrences)
      const from = detectToClipboard(rows, live.start)
      const to = detectToClipboard(rows, live.end)
      if (from === null || to === null) return null
      return { from, to }
    }

    /**
     * Apply one back-to-front edit plan.
     * @param api - live input api.
     * @param edits - edits ordered back to front.
     * @returns whether any edit landed.
     */
    function applyEdits(api, edits) {
      let applied = false
      for (const edit of edits) {
        if (applyEdit(api, edit)) applied = true
      }
      return applied
    }

    /**
     * Run one action against the live selection.
     * @param name - action name.
     * @param api - live input api.
     * @param labels - localized placeholders.
     * @returns whether the draft changed.
     */
    function runAction(name, api, labels) {
      if (api === undefined || typeof api.draft !== 'string') return false
      const selection = liveSelection(api)
      if (selection === null) return false
      const edits = buildEdits(
        name,
        api.draft,
        selection.from,
        selection.to,
        labels,
        occurrenceIndex(api.occurrences),
      )
      if (edits.length === 0) return false
      return applyEdits(api, edits)
    }

    /**
     * Continue a list/quote after a line-break gesture.
     * @param api - live input api.
     * @returns whether the draft changed.
     */
    function runContinuation(api) {
      if (api === undefined || typeof api.draft !== 'string') return false
      const live = api.inputActions?.captureInsertion()
      if (live === undefined) return false
      const rows = occurrenceIndex(api.occurrences)
      const caret = detectToClipboard(rows, live.start)
      if (caret === null || live.start !== live.end) return false
      const edit = continuationEdit(api.draft, caret)
      if (edit === null) return false
      return applyEdit(api, edit)
    }

    // ---------------------------------------------------------------------
    // Preferences and panel state
    // ---------------------------------------------------------------------

    /** Read one persisted boolean preference. */
    function readPref(key, fallback) {
      try {
        const raw = window.localStorage?.getItem(key)
        if (raw === '1') return true
        if (raw === '0') return false
      } catch {
        /* storage may be unavailable; fall through to the default */
      }
      return fallback
    }

    /** Persist one boolean preference. */
    function writePref(key, value) {
      try {
        window.localStorage?.setItem(key, value ? '1' : '0')
      } catch {
        /* best effort */
      }
    }

    /** Tiny observable panel state shared by the toggle and the panel. */
    const panelStore = (() => {
      let state = { open: readPref(PREF_OPEN, true), collapsed: readPref(PREF_COLLAPSED, false) }
      const listeners = new Set()
      return {
        get: () => state,
        set(patch) {
          state = { ...state, ...patch }
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        persist() {
          writePref(PREF_OPEN, state.open)
          writePref(PREF_COLLAPSED, state.collapsed)
        },
      }
    })()

    /** Subscribe one component to the panel state. */
    function usePanelState() {
      return React.useSyncExternalStore(panelStore.subscribe, panelStore.get, panelStore.get)
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    const CSS = [
      // Panel card: the same material as the official composer dock cards.
      '.dsh-md-panel{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-panel);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:0;flex:none;margin:0 auto;overflow:hidden}',
      '.dsh-md-head{align-items:center;gap:8px;padding:4px 6px 4px 12px;display:flex;min-width:0}',
      '.dsh-md-lead{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}',
      '.dsh-md-title{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:24px;white-space:nowrap}',
      '.dsh-md-tools{align-items:center;gap:1px;flex:auto;min-width:0;display:flex;overflow:hidden}',
      '.dsh-md-sep{background:var(--dsw-alias-border-l1);flex:none;width:1px;height:14px;margin:0 5px}',
      '.dsh-md-tool{background:0 0;border:none;border-radius:var(--dsw-radius-sm);width:24px;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;place-items:center;display:grid;padding:0;font:inherit;font-size:12px;line-height:1}',
      '.dsh-md-tool:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-md-tool:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.dsh-md-tool:disabled{opacity:.4;cursor:default}',
      '.dsh-md-tool[data-glyph="bold"]{font-weight:700}',
      '.dsh-md-tool[data-glyph="italic"]{font-style:italic;font-family:var(--dsw-font-serif,Georgia,serif)}',
      '.dsh-md-tool[data-glyph="strike"]{text-decoration:line-through}',
      '.dsh-md-tool[data-glyph="fence"]{font-size:9px;letter-spacing:-.5px}',
      '.dsh-md-tool[data-glyph="quote"]{font-weight:700}',
      '.dsh-md-chevron{margin-left:auto}',
      '.dsh-md-body{max-height:min(38vh,300px);overflow:auto;padding:2px 14px 12px;overscroll-behavior:contain}',
      // The composer tool-row toggle: same geometry as the official round buttons.
      '.dsh-md-toggle{corner-shape:round;background:var(--dsw-specific-selector);width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;border:none;border-radius:999px;flex:none;place-items:center;display:grid;padding:0;font:inherit}',
      '.dsh-md-toggle:hover{color:var(--dsw-alias-label-primary)}',
      '.dsh-md-toggle:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dsh-md-toggle[aria-pressed="true"]{color:var(--dsw-alias-state-business-primary)}',
      '.dsh-md-toggle-glyph{font-size:11px;font-weight:600;line-height:1;letter-spacing:-.2px}',
    ].join('')

    // ---------------------------------------------------------------------
    // Localized copy
    // ---------------------------------------------------------------------

    const ZH = {
      'panel.title': 'Markdown 预览',
      'panel.collapse': '折叠预览',
      'panel.expand': '展开预览',
      'toggle.on': '关闭 Markdown 预览',
      'toggle.off': '打开 Markdown 预览',
      'tool.bold': '加粗',
      'tool.italic': '斜体',
      'tool.strike': '删除线',
      'tool.code': '行内代码',
      'tool.link': '链接',
      'tool.h1': '一级标题',
      'tool.h2': '二级标题',
      'tool.h3': '三级标题',
      'tool.bullet': '无序列表',
      'tool.ordered': '有序列表',
      'tool.task': '任务列表',
      'tool.quote': '引用',
      'tool.fence': '代码块',
      'placeholder.bold': '粗体',
      'placeholder.italic': '斜体',
      'placeholder.strike': '删除线',
      'placeholder.code': '代码',
      'placeholder.linkLabel': '链接文字',
      'markdown.copy': '复制',
      'markdown.copied': '已复制',
      'markdown.codeLabel': '代码',
      'markdown.wrap': '自动换行',
      'markdown.unwrap': '取消自动换行',
      'markdown.footnotes': '脚注',
    }

    const EN = {
      'panel.title': 'Markdown preview',
      'panel.collapse': 'Collapse preview',
      'panel.expand': 'Expand preview',
      'toggle.on': 'Turn off the Markdown preview',
      'toggle.off': 'Turn on the Markdown preview',
      'tool.bold': 'Bold',
      'tool.italic': 'Italic',
      'tool.strike': 'Strikethrough',
      'tool.code': 'Inline code',
      'tool.link': 'Link',
      'tool.h1': 'Heading 1',
      'tool.h2': 'Heading 2',
      'tool.h3': 'Heading 3',
      'tool.bullet': 'Bullet list',
      'tool.ordered': 'Numbered list',
      'tool.task': 'Task list',
      'tool.quote': 'Quote',
      'tool.fence': 'Code block',
      'placeholder.bold': 'bold',
      'placeholder.italic': 'italic',
      'placeholder.strike': 'strike',
      'placeholder.code': 'code',
      'placeholder.linkLabel': 'label',
      'markdown.copy': 'Copy',
      'markdown.copied': 'Copied',
      'markdown.codeLabel': 'Code',
      'markdown.wrap': 'Wrap lines',
      'markdown.unwrap': 'Unwrap lines',
      'markdown.footnotes': 'Footnotes',
    }

    /**
     * Localized placeholder bag for one locale revision.
     * @param t - namespace-bound translate seat.
     * @returns the placeholders the edit core consumes.
     */
    function placeholders(t) {
      return {
        bold: t('placeholder.bold'),
        italic: t('placeholder.italic'),
        strike: t('placeholder.strike'),
        code: t('placeholder.code'),
        linkLabel: t('placeholder.linkLabel'),
      }
    }

    // ---------------------------------------------------------------------
    // Toolbar
    // ---------------------------------------------------------------------

    /** Toolbar buttons, in order; `sep` starts a new visual group. */
    const TOOLBAR = [
      { name: 'bold', glyph: 'B', label: 'tool.bold', shortcut: 'B' },
      { name: 'italic', glyph: 'I', label: 'tool.italic', shortcut: 'I' },
      { name: 'strike', glyph: 'S', label: 'tool.strike', shortcut: 'Shift+X' },
      { name: 'code', icon: IconCodeOutlineRegular, label: 'tool.code', shortcut: 'E' },
      { name: 'link', icon: IconLinkOutlineRegular, label: 'tool.link', shortcut: 'K' },
      { name: 'h1', glyph: 'H1', label: 'tool.h1', shortcut: 'Shift+1', sep: true },
      { name: 'h2', glyph: 'H2', label: 'tool.h2', shortcut: 'Shift+2' },
      { name: 'bullet', icon: IconFlatListOutlineRegular, label: 'tool.bullet', shortcut: 'Shift+8', sep: true },
      { name: 'ordered', glyph: '1.', label: 'tool.ordered', shortcut: 'Shift+7' },
      { name: 'task', icon: IconChecklistOutlineRegular, label: 'tool.task', shortcut: 'Shift+9' },
      { name: 'quote', glyph: '>', label: 'tool.quote', shortcut: 'Shift+.' },
      { name: 'fence', glyph: '```', label: 'tool.fence', shortcut: 'Shift+C' },
    ]

    /** The composer keeps the keyboard: never steal focus on a toolbar press. */
    function keepFocus(event) {
      event.preventDefault()
    }

    /**
     * One toolbar button.
     * @param props - button spec plus the click handler.
     * @returns the button, wrapped in its tooltip.
     */
    function ToolbarButton({ spec, t, disabled, onRun }) {
      const label = t(spec.label)
      const tooltip = {
        label,
        shortcutKeys: shortcutKeycaps(spec.shortcut),
        side: 'top',
        delayMs: 400,
        portal: true,
      }
      return jsx(Tooltip, {
        ...tooltip,
        children: jsx('button', {
          type: 'button',
          className: 'dsh-md-tool',
          'data-glyph': spec.glyph === undefined ? undefined : spec.name,
          'aria-label': label,
          disabled,
          onMouseDown: keepFocus,
          onClick: () => onRun(spec.name),
          children:
            spec.icon === undefined
              ? jsx('span', { children: spec.glyph })
              : jsx(spec.icon, { size: 14 }),
        }),
      })
    }

    // ---------------------------------------------------------------------
    // Preview panel
    // ---------------------------------------------------------------------

    /**
     * The live preview panel above the composer card.
     * @param props - slot props (standard session kit plus the dock owner).
     * @returns the panel, or nothing while it is off or the draft is empty.
     */
    function MarkdownDock(props) {
      const { t, useInput, inputActions } = props
      const panel = usePanelState()
      const input = useInput === undefined ? undefined : useInput((state) => state)
      const draft = input?.draft ?? ''
      const deferredDraft = React.useDeferredValue === undefined ? draft : React.useDeferredValue(draft)

      const labels = React.useMemo(
        () => ({
          code: {
            copyLabel: t('markdown.copy'),
            copiedLabel: t('markdown.copied'),
            toolbarLabels: {
              codeLabel: t('markdown.codeLabel'),
              wrapLabel: t('markdown.wrap'),
              unwrapLabel: t('markdown.unwrap'),
            },
          },
          footnotes: t('markdown.footnotes'),
        }),
        [t],
      )

      const openExternalLink = React.useCallback((url) => {
        window.open(url, '_blank', 'noopener,noreferrer')
      }, [])

      if (!panel.open || draft === '') return null

      const api = { draft, occurrences: input?.occurrences, inputActions }
      const disabled = inputActions === undefined || input?.phase !== 'plain'
      const placeholdersForRun = placeholders(t)

      return jsx('div', {
        className: 'dsh-md-panel',
        'data-markdown-composer': 'panel',
        children: [
          jsxs('div', {
            className: 'dsh-md-head',
            children: [
              jsx('span', {
                className: 'dsh-md-lead',
                'aria-hidden': true,
                children: jsx(IconCodeOutlineRegular, { size: 14 }),
              }),
              jsx('span', { className: 'dsh-md-title', children: t('panel.title') }),
              jsx('div', {
                className: 'dsh-md-tools',
                children: TOOLBAR.map((spec) =>
                  jsxs(
                    Fragment,
                    {
                      children: [
                        spec.sep === true
                          ? jsx('span', { className: 'dsh-md-sep', 'aria-hidden': true })
                          : null,
                        jsx(ToolbarButton, {
                          spec,
                          t,
                          disabled,
                          onRun: (name) => runAction(name, api, placeholdersForRun),
                        }),
                      ],
                    },
                    spec.name,
                  ),
                ),
              }),
              jsx(Tooltip, {
                label: panel.collapsed ? t('panel.expand') : t('panel.collapse'),
                side: 'top',
                delayMs: 400,
                portal: true,
                children: jsx('button', {
                  type: 'button',
                  className: 'dsh-md-tool dsh-md-chevron',
                  'aria-label': panel.collapsed ? t('panel.expand') : t('panel.collapse'),
                  'aria-expanded': !panel.collapsed,
                  onMouseDown: keepFocus,
                  onClick: () => {
                    panelStore.set({ collapsed: !panel.collapsed })
                    panelStore.persist()
                  },
                  children: panel.collapsed
                    ? jsx(IconChevronUpOutlineRegular, { size: 14 })
                    : jsx(IconChevronDownOutlineRegular, { size: 14 }),
                }),
              }),
            ],
          }),
          panel.collapsed
            ? null
            : jsx('div', {
                className: 'dsh-md-body',
                children: jsx(MarkdownDelegateProvider, {
                  openExternalLink,
                  children: jsx(MarkdownText, { text: deferredDraft, labels }),
                }),
              }),
        ],
      })
    }

    // ---------------------------------------------------------------------
    // Composer tool-row toggle + keyboard behaviour
    // ---------------------------------------------------------------------

    /**
     * The action shortcut one keydown spells, or undefined.
     *
     * Physical key codes are read first: with Shift held, `event.key` reports
     * the shifted character (`*` for Shift+8, `(` for Shift+9), so a
     * character-based lookup would miss every digit shortcut on a US layout
     * and every punctuation shortcut elsewhere.
     *
     * @param event - the keydown event.
     * @returns the action name, or undefined when no shortcut matches.
     */
    function shortcutOf(event) {
      const code = typeof event.code === 'string' ? event.code : ''
      let key
      if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase()
      else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
      else if (code === 'Period') key = '.'
      else if (code === 'Comma') key = ','
      else if (code === 'Slash') key = '/'
      else key = String(event.key ?? '').toLowerCase()
      // The table is lowercase throughout: normalize the modifier prefix too.
      return SHORTCUTS.get(`${event.shiftKey ? 'shift+' : ''}${key}`)
    }

    /**
     * The composer tool-row toggle; it also installs the composer's markdown
     * keyboard behaviour for as long as a live composer is mounted.
     * @param props - slot props (standard session kit).
     * @returns the round toggle button.
     */
    function MarkdownToggle(props) {
      const { t, useInput, inputActions } = props
      const panel = usePanelState()
      const input = useInput === undefined ? undefined : useInput((state) => state)
      const live = React.useRef({ draft: input?.draft, occurrences: input?.occurrences, inputActions })
      live.current = { draft: input?.draft, occurrences: input?.occurrences, inputActions }

      React.useEffect(() => {
        if (inputActions === undefined) return undefined
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
          if (event[HANDLED] === true) return
          const target = event.target
          if (!(target instanceof Element) || target.closest('[data-lexical-editor="true"]') === null) {
            return
          }
          if (event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
            // Let the shell insert the line break, then continue the block.
            event[HANDLED] = true
            window.requestAnimationFrame(() => {
              runContinuation(live.current)
            })
            return
          }
          if (!(event.metaKey || event.ctrlKey) || event.altKey) return
          const name = shortcutOf(event)
          if (name === undefined) return
          event[HANDLED] = true
          event.preventDefault()
          event.stopPropagation()
          runAction(name, live.current, placeholders(t))
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [inputActions, t])

      const label = panel.open ? t('toggle.on') : t('toggle.off')
      return jsx(Tooltip, {
        label,
        side: 'top',
        delayMs: 400,
        portal: true,
        children: jsx('button', {
          type: 'button',
          className: 'dsh-md-toggle',
          'aria-label': label,
          'aria-pressed': panel.open,
          onMouseDown: keepFocus,
          onClick: () => {
            panelStore.set({ open: !panel.open })
            panelStore.persist()
          },
          children: jsx('span', { className: 'dsh-md-toggle-glyph', children: 'M↓' }),
        }),
      })
    }

    // ---------------------------------------------------------------------
    // Plugin
    // ---------------------------------------------------------------------

    /**
     * Register the plugin's slots, locale and stylesheet.
     * @param ctx - owning Cordis context.
     */
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) {
        ctx.logger?.error?.('markdown-composer: slots service is unavailable; nothing registered')
        return
      }
      const styles = ctx.get('styles')
      if (styles !== undefined && typeof styles.insert === 'function') {
        ctx.effect(() => styles.insert(CSS), 'markdown-composer: stylesheet')
      } else if (typeof document !== 'undefined') {
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.setAttribute('data-plugin', 'dsh-markdown-composer')
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'markdown-composer: stylesheet')
      }
      const locale = ctx.get('locale')
      if (locale !== undefined && typeof locale.register === 'function') {
        ctx.effect(
          () => locale.register(NS, { zh: ZH, en: EN }),
          'markdown-composer: locale namespace',
        )
      } else {
        ctx.logger?.warn?.('markdown-composer: locale service unavailable; copy falls back to keys')
      }
      ctx.effect(
        () =>
          slots.inject('conversation.input.dock', () =>
            slots.register(
              { name: 'conversation.input.dock', id: 'markdown-preview', order: 30, locale: NS },
              MarkdownDock,
            ),
          ),
        'markdown-composer: preview panel',
      )
      ctx.effect(
        () =>
          slots.inject('conversation.input.left', () =>
            slots.register(
              { name: 'conversation.input.left', id: 'markdown-toggle', order: 30, locale: NS },
              MarkdownToggle,
            ),
          ),
        'markdown-composer: composer toggle',
      )
    }

    return {
      name: 'markdown-composer',
      // `locale` is a hard dependency: the toolbar and panel copy is localized
      // through the namespace registered in apply.
      inject: ['slots', 'locale'],
      apply,
      // Test seam: the pure edit core, exercised by test/core.test.js without a browser.
      __internals: {
        ordered,
        lineBounds,
        occurrenceIndex,
        clipboardToDetect,
        detectToClipboard,
        clipboardRangeToDetect,
        inlineWrapEdit,
        stripBlockMarker,
        chipFree,
        inlineEdits,
        linePrefixEdits,
        fenceEdits,
        buildEdits,
        shortcutOf,
        linePrefixEdit,
        headingKind,
        fenceEdit,
        linkEdit,
        listContinuation,
        continuationEdit,
        buildEdit,
        ACTIONS,
        LINE_KINDS,
        SHORTCUTS,
      },
    }
  },
})
