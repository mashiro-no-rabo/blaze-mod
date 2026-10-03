import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { chunkMarkdown, parseFrontmatter, parseLog } from '../hooks/lib'

const ROOT = '/repo'
const WC = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
const PARENT = 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk'
const GRANDPARENT = 'mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm'
const OLDEST = 'nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn'

const FILES: Record<string, string> = {
  [`${ROOT}/.blaze/${PARENT}/plans/PLAN.md`]: '# Plan body\n\nShip it.',
  [`${ROOT}/.blaze/${PARENT}/plans/PLAN_EXTRA.md`]: '# Extra plan\n\nSecond file.',
  [`${ROOT}/.blaze/${PARENT}/tickets/001_task_1.md`]:
    '---\ntitle: First task\nstatus: doing\ndepends_on: [000]\n---\nTicket one body.',
  [`${ROOT}/.blaze/${GRANDPARENT}/plans/OLD.md`]: '# Old plan',
  [`${ROOT}/.blaze/${OLDEST}/tickets/001_oldest.md`]: '---\ntitle: Oldest task\nstatus: done\n---\nOldest ticket body.',
}

function entries(path: string) {
  const prefix = `${path}/`
  const names = new Map<string, 'file' | 'dir'>()
  for (const file of Object.keys(FILES)) {
    if (!file.startsWith(prefix)) continue
    const rest = file.slice(prefix.length).split('/')
    names.set(rest[0] ?? '', rest.length === 1 ? 'file' : 'dir')
  }
  return [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false }))
}

const RAN = { isStdoutTruncated: false, isStderrTruncated: false }

const PANE = {
  component: 'Pane',
  requestId: 'blaze',
  props: {
    title: 'Blaze',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

describe('lib', () => {
  test('parses jj log rows', async () => {
    const rows = parseLog(`${WC}\tzz\t@\twip\n${PARENT}\tk\t\tadd planner\twith tab\n`)
    expect(rows).toEqual([
      { changeId: WC, shortId: 'zz', isWorkingCopy: true, description: 'wip' },
      { changeId: PARENT, shortId: 'k', isWorkingCopy: false, description: 'add planner\twith tab' },
    ])
  })

  test('parses frontmatter scalars, inline and block lists', async () => {
    const parsed = parseFrontmatter('---\ntitle: "A"\ntags:\n  - x\n  - y\ndeps: [1, 2]\n---\nbody')
    expect(parsed.fields).toEqual([
      ['title', 'A'],
      ['tags', ['x', 'y']],
      ['deps', ['1', '2']],
    ])
    expect(parsed.body).toBe('body')
    expect(parseFrontmatter('# no fm').fields).toEqual([])
  })

  test('chunks long markdown under the element cap without splitting fences', async () => {
    const para = 'x'.repeat(4000)
    const body = [para, '', '```', para, '', para, '```', '', para].join('\n')
    const chunks = chunkMarkdown(body)
    for (const chunk of chunks) {
      expect(chunk.length <= 10000).toBe(true)
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0)
    }
    expect(chunks.length > 1).toBe(true)
    expect(chunkMarkdown('short')).toEqual(['short'])
  })
})

function mockRepo(on: On) {
  on('process.run', async (_$, e) => {
    if (e.argv.includes('root')) return { value: { exitCode: 0, stdout: `${ROOT}\n`, stderr: '', ...RAN } }
    return {
      value: {
        exitCode: 0,
        stdout: `${WC}\tzzzzzzzz\t@\twip\n${PARENT}\tkkkkkkkk\t\tadd planner\n${GRANDPARENT}\tmmmmmmmm\t\told work\n${OLDEST}\tnnnnnnnn\t\toldest\n`,
        stderr: '',
        ...RAN,
      },
    }
  })
  on('fs.list', async (_$, e) => ({ value: entries(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = FILES[e.path]
    if (text === undefined) throw new Error(`missing ${e.path}`)
    return { value: text }
  })
}

test('pane splits plans, tickets and diff into tabs', async ($, on) => {
  mockRepo(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'blaze', surface, ...PANE })
    await ui.press({ key: 'refresh' })

    expect(await ui.find({ type: 'Select', key: 'change' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '>PLAN 2<' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'tab-tickets', text: '[TICKETS 1]' })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Ship it/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'First task' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /plans\/PLAN\.md/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: `open-${ROOT}/.blaze/${PARENT}/plans/PLAN.md` })).toBeUndefined()

    expect(await ui.find({ type: 'Select', key: 'plan' })).toBeDefined()
    await ui.select({ key: 'plan', value: `${ROOT}/.blaze/${PARENT}/plans/PLAN_EXTRA.md` })
    expect(await ui.find({ type: 'Markdown', text: /Second file/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /plans\/PLAN_EXTRA\.md/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Ship it/ })).toBeUndefined()
    await ui.select({ key: 'plan', value: `${ROOT}/.blaze/${PARENT}/plans/PLAN.md` })

    await ui.press({ key: 'tab-tickets' })
    expect(await ui.find({ type: 'Button', text: 'First task' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '>TICKETS 1<' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\[doing\]/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Ship it/ })).toBeUndefined()
    await ui.press({ key: `open-${ROOT}/.blaze/${PARENT}/tickets/001_task_1.md` })
    expect(await ui.find({ type: 'Markdown', text: /Ticket one body/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /depends_on/ })).toBeDefined()

    await ui.press({ key: 'tab-diff' })
    expect(await ui.find({ type: 'Text', text: 'Not implemented yet.' })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Ticket one body/ })).toBeUndefined()

    await ui.press({ key: 'tab-tickets' })
    await ui.select({ key: 'change', value: GRANDPARENT })
    expect(await ui.find({ type: 'Text', text: 'No tickets/ for mmmmmmmm' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'First task' })).toBeUndefined()

    await ui.select({ key: 'change', value: OLDEST })
    expect(await ui.find({ type: 'Button', text: 'Oldest task' })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Oldest ticket body/ })).toBeDefined()

    await ui.press({ key: 'tab-plan' })
    expect(await ui.find({ type: 'Text', text: 'No plans/ for nnnnnnnn' })).toBeDefined()

    await ui.select({ key: 'change', value: GRANDPARENT })
    expect(await ui.find({ type: 'Markdown', text: /Old plan/ })).toBeDefined()
    expect(await ui.find({ type: 'Select', key: 'plan' })).toBeUndefined()

    await ui.select({ key: 'change', value: PARENT })
    await ui.unmount()
  }
})

test('pane tabs work on mobile without a change picker', async ($, on) => {
  mockRepo(on)

  const ui = await $.ui.mount({ plugin: 'blaze', surface: 'mobile', ...PANE })
  await ui.press({ key: 'refresh' })

  expect(await ui.find({ type: 'Select', key: 'change' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'kkkkkkkk add planner' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /Ship it/ })).toBeDefined()

  expect(await ui.find({ type: 'Select', key: 'plan' })).toBeUndefined()
  await ui.press({ key: `open-${ROOT}/.blaze/${PARENT}/plans/PLAN_EXTRA.md` })
  expect(await ui.find({ type: 'Markdown', text: /Second file/ })).toBeDefined()

  await ui.press({ key: 'tab-tickets' })
  expect(await ui.find({ type: 'Markdown', text: /Ticket one body/ })).toBeDefined()

  await ui.press({ key: 'tab-diff' })
  expect(await ui.find({ type: 'Text', text: 'Not implemented yet.' })).toBeDefined()
  await ui.unmount()
})
