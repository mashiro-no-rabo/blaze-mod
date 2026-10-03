export type LogEntry = { changeId: string; shortId: string; isWorkingCopy: boolean; description: string }

export type FieldValue = string | string[]

export type Parsed = { fields: [string, FieldValue][]; body: string }

export const LOG_TEMPLATE =
  'change_id ++ "\\t" ++ change_id.shortest(8) ++ "\\t" ++ if(current_working_copy, "@", "") ++ "\\t" ++ description.first_line() ++ "\\n"'

const TYPE_ORDER = ['plans', 'tickets']

export function parseLog(stdout: string): LogEntry[] {
  return stdout
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => {
      const [changeId = '', shortId = '', mark = '', ...rest] = line.split('\t')
      return { changeId, shortId, isWorkingCopy: mark === '@', description: rest.join('\t') }
    })
    .filter(entry => entry.changeId.length > 0)
}

function scalar(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1)
  }
  return v
}

export function parseFrontmatter(text: string): Parsed {
  const normalized = text.replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized)
  if (!match) return { fields: [], body: normalized }

  const fields: [string, FieldValue][] = []
  for (const line of (match[1] ?? '').split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item) {
      const value = scalar(item[1] ?? '')
      const last = fields[fields.length - 1]
      if (last) {
        const prev = last[1]
        last[1] = Array.isArray(prev)
          ? [...prev, value]
          : prev === ''
            ? [value]
            : [prev, value]
      }
      continue
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    const key = kv?.[1]
    if (kv === null || key === undefined) continue
    const raw = (kv[2] ?? '').trim()
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1).trim()
      fields.push([key, inner === '' ? [] : inner.split(',').map(scalar)])
    } else {
      fields.push([key, scalar(raw)])
    }
  }
  return { fields, body: normalized.slice(match[0].length) }
}

export function field(parsed: Parsed, key: string): string | null {
  const hit = parsed.fields.find(([k]) => k === key)
  if (!hit) return null
  return Array.isArray(hit[1]) ? hit[1].join(', ') : hit[1]
}

export function stem(name: string): string {
  return name.replace(/\.md$/i, '')
}

export function artifactTitle(type: string, name: string, parsed: Parsed): string {
  if (type === 'plans') return name
  return field(parsed, 'title') ?? stem(name)
}

export function compareTypes(a: string, b: string): number {
  const ia = TYPE_ORDER.indexOf(a)
  const ib = TYPE_ORDER.indexOf(b)
  if (ia !== -1 || ib !== -1) return (ia === -1 ? TYPE_ORDER.length : ia) - (ib === -1 ? TYPE_ORDER.length : ib)
  return a.localeCompare(b)
}

// Markdown elements cap at 10000 characters; prefer cutting at blank lines outside code fences,
// and close/reopen a fence when a forced cut lands inside one.
export function chunkMarkdown(body: string, soft = 8000, hard = 9500): string[] {
  const chunks: string[] = []
  let current: string[] = []
  let size = 0
  let fence: string | null = null

  const flush = () => {
    if (current.length === 0) return
    if (fence !== null) current.push(fence)
    chunks.push(current.join('\n'))
    current = fence !== null ? [fence] : []
    size = fence !== null ? fence.length + 1 : 0
  }

  for (const whole of body.split('\n')) {
    const pieces: string[] = []
    for (let i = 0; i < Math.max(whole.length, 1); i += hard) pieces.push(whole.slice(i, i + hard))
    for (const line of pieces) {
      if (size + line.length + 1 > hard) flush()
      const marker = /^\s*(```+|~~~+)/.exec(line)?.[1]
      if (marker !== undefined) fence = fence === null ? marker : null
      current.push(line)
      size += line.length + 1
      if (fence === null && line.trim() === '' && size >= soft) flush()
    }
  }
  const tail = current.join('\n')
  if (tail.trim().length > 0 || chunks.length === 0) chunks.push(tail)
  return chunks
}

export function statusColor(status: string): string | undefined {
  switch (status.toLowerCase()) {
    case 'done':
    case 'complete':
    case 'completed':
      return 'success'
    case 'doing':
    case 'in_progress':
    case 'in-progress':
    case 'active':
      return 'warning'
    case 'blocked':
      return 'error'
    default:
      return undefined
  }
}
