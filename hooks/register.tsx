import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pending } from '../types'

// ─── constants ──────────────────────────────────────────────────────────────

const PLUGIN = 'shhstore'
const PANE = 'shh-input'
const SERVICE = 'shhstore'
const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const PLACEHOLDER_RE = /\{\{shh:([A-Za-z][A-Za-z0-9_]*)\}\}/g
// Values shorter than this are not redacted: too likely to collide with
// ordinary text ("true", "8080") and wreck unrelated output.
const MIN_REDACT = 6
const INPUT_TIMEOUT_MS = 10 * 60 * 1000

// Tools whose input may carry {{shh:NAME}} placeholders that get expanded to
// the real value right before the tool runs. Everything the model can read
// back (Agent prompts, TodoWrite, WebFetch URLs, ...) is deliberately absent.
const EXPANDING_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const RESERVED_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])

const pendingAtom = atom({ plugin: 'shhstore', key: 'pending' } as const, null, {
  shape: 'pending-1',
})

// ─── known key shapes, for keys pasted straight into the prompt ────────────

type Pattern = { re: RegExp; name: string }

const PATTERNS: Pattern[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g, name: 'PRIVATE_KEY' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, name: 'ANTHROPIC_API_KEY' },
  { re: /\bsk-or-v1-[A-Za-z0-9]{32,}/g, name: 'OPENROUTER_API_KEY' },
  { re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g, name: 'OPENAI_API_KEY' },
  { re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g, name: 'STRIPE_SECRET_KEY' },
  { re: /\bwhsec_[A-Za-z0-9]{20,}/g, name: 'STRIPE_WEBHOOK_SECRET' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}/g, name: 'GITHUB_TOKEN' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g, name: 'GITHUB_TOKEN' },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g, name: 'GITLAB_TOKEN' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, name: 'AWS_ACCESS_KEY_ID' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, name: 'GOOGLE_API_KEY' },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, name: 'SLACK_TOKEN' },
  { re: /\bgsk_[A-Za-z0-9]{40,}/g, name: 'GROQ_API_KEY' },
  { re: /\bhf_[A-Za-z0-9]{30,}/g, name: 'HF_TOKEN' },
  { re: /\bxai-[A-Za-z0-9]{40,}/g, name: 'XAI_API_KEY' },
  { re: /\bpplx-[A-Za-z0-9]{40,}/g, name: 'PERPLEXITY_API_KEY' },
  { re: /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,}/g, name: 'RESEND_API_KEY' },
  { re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, name: 'SENDGRID_API_KEY' },
  { re: /\bnpm_[A-Za-z0-9]{36}\b/g, name: 'NPM_TOKEN' },
  { re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g, name: 'TELEGRAM_BOT_TOKEN' },
]

// `SOME_SECRET=value` lines pasted from an .env file.
const ASSIGN_RE =
  /^[ \t]*(?:export[ \t]+)?([A-Za-z][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|DSN|PRIVATE|CREDENTIALS?)[A-Za-z0-9_]*)[ \t]*=[ \t]*(['"]?)([^\s'"]{8,}|[^'"\n]{8,})\2[ \t]*$/gim

// ─── module state (rebuilt on every reload from the keychain) ───────────────

type Meta = { length: number; createdAt: string; source: string; description?: string }
type Index = Record<string, Meta>
type Backend = 'keychain' | 'secret-tool' | 'store'

const secrets = new Map<string, string>()
let backend: Backend = 'store'
let waiter: ((r: { ok: true } | { ok: false; reason: string }) => void) | null = null

// ─── small helpers ──────────────────────────────────────────────────────────

const normName = (raw: string) => raw.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')
const ph = (name: string) => `{{shh:${name}}}`

function redactString(text: string): string {
  if (secrets.size === 0 || text.length < MIN_REDACT) return text
  const byLength = [...secrets.entries()]
    .filter(([, v]) => v.length >= MIN_REDACT)
    .sort((a, b) => b[1].length - a[1].length)
  let out = text
  for (const [name, value] of byLength) {
    if (out.includes(value)) out = out.split(value).join(ph(name))
  }
  return out
}

function deepMap(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map(v => deepMap(v, fn))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepMap(v, fn)
    return out
  }
  return value
}

function containsSecret(value: unknown): boolean {
  let hit = false
  deepMap(value, s => {
    if (!hit && redactString(s) !== s) hit = true
    return s
  })
  return hit
}

function placeholdersIn(value: unknown): string[] {
  const names = new Set<string>()
  deepMap(value, s => {
    for (const m of s.matchAll(PLACEHOLDER_RE)) if (m[1]) names.add(m[1].toUpperCase())
    return s
  })
  return [...names]
}

function expandString(text: string): string {
  return text.replace(PLACEHOLDER_RE, (all, n: string) => secrets.get(n.toUpperCase()) ?? all)
}

function envLiteral(value: string): string {
  if (/^[A-Za-z0-9_\-.\/+=:@,%~]+$/.test(value)) return value
  if (!value.includes("'") && !value.includes('\n')) return `'${value}'`
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`').replace(/\n/g, '\\n')}"`
}

// ─── storage backends ───────────────────────────────────────────────────────

type $T = EngineInterface

async function detectBackend($: $T): Promise<Backend> {
  const ok = async (argv: string[]) =>
    $.process.run(argv, { timeoutMs: 5000 }).then(
      (r: { exitCode: number }) => r.exitCode === 0 || r.exitCode === 1 || r.exitCode === 2,
      () => false,
    )
  if (await ok(['/usr/bin/security', 'list-keychains'])) return 'keychain'
  if (await ok(['secret-tool', '--version'])) return 'secret-tool'
  return 'store'
}

const kcQuote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

async function backendSet($: $T, name: string, value: string): Promise<void> {
  if (backend === 'keychain') {
    const cmd = `add-generic-password -U -s ${SERVICE} -a ${name} -l ${kcQuote(`shhstore: ${name}`)} -w ${kcQuote(value)}\n`
    const r = await $.process.run(['/usr/bin/security', '-i'], { stdin: cmd, timeoutMs: 15000 })
    const back = await backendGet($, name)
    if (r.exitCode !== 0 || back !== value) throw new Error(`keychain write failed: ${(r.stderr || '').slice(0, 200)}`)
    return
  }
  if (backend === 'secret-tool') {
    const r = await $.process.run(
      ['secret-tool', 'store', `--label=shhstore: ${name}`, 'service', SERVICE, 'account', name],
      { stdin: value, timeoutMs: 15000 },
    )
    if (r.exitCode !== 0) throw new Error(`secret-tool failed: ${(r.stderr || '').slice(0, 200)}`)
    return
  }
  await $.store.set(`value:${name}`, value)
}

async function backendGet($: $T, name: string): Promise<string | undefined> {
  if (backend === 'keychain') {
    const r = await $.process.run(['/usr/bin/security', 'find-generic-password', '-s', SERVICE, '-a', name, '-w'], { timeoutMs: 15000 })
    return r.exitCode === 0 ? r.stdout.replace(/\n$/, '') : undefined
  }
  if (backend === 'secret-tool') {
    const r = await $.process.run(['secret-tool', 'lookup', 'service', SERVICE, 'account', name], { timeoutMs: 15000 })
    return r.exitCode === 0 ? r.stdout.replace(/\n$/, '') : undefined
  }
  const v = await $.store.get(`value:${name}`)
  return typeof v === 'string' ? v : undefined
}

async function backendDelete($: $T, name: string): Promise<void> {
  if (backend === 'keychain') {
    await $.process.run(['/usr/bin/security', 'delete-generic-password', '-s', SERVICE, '-a', name], { timeoutMs: 15000 })
  } else if (backend === 'secret-tool') {
    await $.process.run(['secret-tool', 'clear', 'service', SERVICE, 'account', name], { timeoutMs: 15000 })
  } else {
    await $.store.delete(`value:${name}`)
  }
}

async function getIndex($: $T): Promise<Index> {
  const v = await $.store.get('index')
  return v && typeof v === 'object' ? (v as Index) : {}
}

async function saveSecret($: $T, name: string, value: string, source: string, description?: string) {
  await backendSet($, name, value)
  secrets.set(name, value)
  const index = await getIndex($)
  index[name] = { length: value.length, createdAt: new Date().toISOString(), source, description }
  await $.store.set('index', index)
}

async function removeSecret($: $T, name: string) {
  await backendDelete($, name)
  secrets.delete(name)
  const index = await getIndex($)
  delete index[name]
  await $.store.set('index', index)
}

// A name for a pasted key: reuse the one already holding this value, else the
// base name, else BASE_2, BASE_3 ...
function nameForPasted(base: string, value: string, taken: Set<string>): string {
  for (const [n, v] of secrets) if (v === value) return n
  if (!secrets.has(base) && !taken.has(base)) return base
  for (let i = 2; ; i++) {
    const n = `${base}_${i}`
    if (!secrets.has(n) && !taken.has(n)) return n
  }
}

// ─── macOS hidden dialog (fallback / "hidden input" button) ────────────────

const DIALOG = [
  'on run argv',
  'activate',
  'set r to display dialog (item 1 of argv) default answer "" with hidden answer with title "shhstore" buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel" giving up after 600',
  'if gave up of r then error number -128',
  'return text returned of r',
  'end run',
]

async function askViaDialog($: $T, name: string, description?: string): Promise<string | undefined> {
  if (backend !== 'keychain') return undefined
  const prompt = `Paste the value for ${name}${description ? `\n(${description})` : ''}\n\nIt goes straight to the macOS Keychain; Claude never sees it.`
  const argv = ['/usr/bin/osascript', ...DIALOG.flatMap(l => ['-e', l]), prompt]
  const r = await $.process.run(argv, { timeoutMs: INPUT_TIMEOUT_MS }).catch(() => undefined)
  if (!r || r.exitCode !== 0) return undefined
  const v = r.stdout.replace(/\r?\n$/, '')
  return v.length > 0 ? v : undefined
}

// ─── the input pane ─────────────────────────────────────────────────────────

function finish(r: { ok: true } | { ok: false; reason: string }) {
  const w = waiter
  waiter = null
  w?.(r)
}

async function submitValue($: $T, raw: string, source: string) {
  const pending = await read($, pendingAtom)
  if (!pending) return
  const value = raw.replace(/^\s+|\s+$/g, '')
  if (value.length === 0) {
    await update($, pendingAtom, p => (p ? { ...p, error: 'Empty value: paste the key and press Enter, or Esc to cancel.' } : p))
    return
  }
  try {
    await saveSecret($, pending.name, value, source, pending.description)
  } catch (err) {
    await update($, pendingAtom, p => (p ? { ...p, error: String(err) } : p))
    return
  }
  await update($, pendingAtom, () => null)
  await $.ui.close({ id: PANE }).catch(() => {})
  $.ui.toast(`🔒 ${pending.name} saved (${value.length} chars). Claude sees only ${ph(pending.name)}.`)
  finish({ ok: true })
}

async function openInput($: $T, name: string, description?: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (waiter) return { ok: false, reason: 'Another secret prompt is already open; wait for the user to finish it.' }
  await update($, pendingAtom, () => ({ name, description }))
  const done = new Promise<{ ok: true } | { ok: false; reason: string }>(resolve => {
    waiter = resolve
  })
  const opened = await $.ui
    .open({ id: PANE, title: `🔒 ${name}`, focus: true, closeOnEscape: true, holdToasts: true, rows: 7 })
    .catch((err: unknown) => ({ isPlaced: false, reason: String(err) }))

  if (!opened.isPlaced) {
    // No room for a pane (narrow terminal, no surface): fall back to the
    // native hidden dialog where there is one.
    await $.ui.close({ id: PANE }).catch(() => {})
    await update($, pendingAtom, () => ({ name, description }))
    const v = await askViaDialog($, name, description)
    if (v !== undefined) {
      await submitValue($, v, 'dialog')
    } else {
      await update($, pendingAtom, () => null)
      finish({
        ok: false,
        reason: `Could not open the input (${(opened as { reason?: string }).reason ?? 'no room'}). Ask the user to type /secret ${name} themselves.`,
      })
    }
    return done
  }

  const timer = $.clock.after(INPUT_TIMEOUT_MS, () => {
    void update($, pendingAtom, () => null)
    void $.ui.close({ id: PANE }).catch(() => {})
    finish({ ok: false, reason: 'Timed out waiting for the user.' })
  })
  const result = await done
  timer.cancel()
  return result
}

// ─── .env upsert ────────────────────────────────────────────────────────────

async function envSet($: $T, file: string, varName: string, name: string, value: string): Promise<string> {
  const exists = await $.fs.exists(file)
  const text: string = exists ? await $.fs.read(file) : ''
  const lines = text.length ? text.split('\n') : []
  const re = new RegExp(`^(\\s*(?:export\\s+)?)${varName.replace(/\./g, '\\.')}\\s*=`)
  const line = (prefix: string) => `${prefix}${varName}=${envLiteral(value)}`
  let action = 'added'
  const i = lines.findIndex(l => re.test(l))
  if (i >= 0) {
    lines[i] = line(re.exec(lines[i] ?? '')?.[1] ?? '')
    action = 'updated'
  } else {
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    lines.push(line(''), '')
  }
  if (lines[lines.length - 1] !== '') lines.push('')
  await $.fs.write(file, lines.join('\n'))
  if (!exists) await $.process.run(['chmod', '600', file]).catch(() => {})

  let note = ''
  const ig = await $.process.run(['git', 'check-ignore', '-q', file], { timeoutMs: 5000 }).catch(() => undefined)
  if (ig && ig.exitCode === 1) note = ` WARNING: ${file} is NOT git-ignored — tell the user and offer to add it to .gitignore.`
  return `${action} ${varName}=${ph(name)} in ${file}${exists ? '' : ' (new file, chmod 600)'}.${note}`
}

// ─── the module ─────────────────────────────────────────────────────────────

const TOOL_GUIDE =
  'Secrets are referenced by placeholders {{shh:NAME}}. In Bash commands and in Write/Edit/MultiEdit/NotebookEdit inputs ' +
  'the placeholder is replaced with the real value right before the tool runs, and every tool output has known secret values ' +
  'replaced back with the placeholder — so you can e.g. Write `OPENAI_API_KEY={{shh:OPENAI_API_KEY}}` into .env, or run ' +
  '`curl -H "Authorization: Bearer {{shh:OPENAI_API_KEY}}" ...`, without ever seeing the key. Reading a .env shows placeholders ' +
  'for stored values. Never try to decode, print, base64 or otherwise reveal a secret.'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    backend = await detectBackend($)
    const index = await getIndex($)
    for (const name of Object.keys(index)) {
      const v = await backendGet($, name).catch(() => undefined)
      if (v !== undefined) secrets.set(name, v)
    }
    await update($, pendingAtom, () => null)

    await $.command.register({ name: 'secret', description: 'Enter a secret privately (it never reaches the chat)', argumentHint: 'NAME' })
    await $.command.register({ name: 'secrets', description: 'List stored secrets (names only)' })

    await $.tool.register({
      name: 'request_secret',
      description:
        'Ask the user for a secret (API key, token, password) through a private input that never enters the conversation. ' +
        'ALWAYS use this instead of asking the user to paste a key into the chat. Blocks until the user submits or cancels. ' +
        'Check list_secrets first: the key may already be stored. ' +
        TOOL_GUIDE,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Env-style name, e.g. OPENAI_API_KEY (uppercase, digits, _).' },
          description: { type: 'string', description: 'One line shown to the user: what the key is for / where to get it.' },
          overwrite: { type: 'boolean', description: 'Replace an existing secret with this name. Default false.' },
        },
        required: ['name'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'list_secrets',
      description: 'List stored secrets: names, lengths, dates. Values are never returned. ' + TOOL_GUIDE,
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'write_secret_to_env',
      description:
        'Insert or update VAR=<secret value> in a dotenv file (creates it if missing, keeps the other lines) without you reading the file. ' +
        'Warns if the file is not git-ignored.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Stored secret name.' },
          file: { type: 'string', description: 'Path to the .env file, relative to the working directory or absolute.' },
          var: { type: 'string', description: 'Variable name in the file; defaults to the secret name.' },
        },
        required: ['name', 'file'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'delete_secret',
      description: 'Delete a stored secret (the user is asked to confirm).',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      isDeferred: false,
    })

    if (backend === 'store') {
      $.ui.log('shhstore: no OS keychain found (macOS security / libsecret secret-tool); secrets fall back to the plugin store file.')
    }
    return next(e)
  })

  // ── own tools ────────────────────────────────────────────────────────────

  on('tool.call', { tool: 'mcp__shhstore__request_secret' }, async ($, e) => {
    const input = e as unknown as { name?: string; description?: string; overwrite?: boolean }
    const name = normName(input.name ?? '')
    if (!NAME_RE.test(name)) return { deny: `Bad name "${input.name}". Use something like OPENAI_API_KEY.` }
    if (secrets.has(name) && !input.overwrite) {
      return { result: `${name} is already stored (${secrets.get(name)!.length} chars). Use ${ph(name)}. Pass overwrite: true only if the user wants to replace it.` }
    }
    const r = await openInput($, name, input.description)
    if (!r.ok) return { deny: r.reason }
    return {
      result: `Stored ${name} (${secrets.get(name)?.length ?? '?'} chars). Reference it as ${ph(name)} or use write_secret_to_env.`,
    }
  })

  on('tool.call', { tool: 'mcp__shhstore__list_secrets' }, async $ => {
    const index = await getIndex($)
    const rows = Object.entries(index)
      .filter(([n]) => secrets.has(n))
      .map(([n, m]) => `${ph(n)}  ${m.length} chars, ${m.source}, ${m.createdAt.slice(0, 10)}${m.description ? ` — ${m.description}` : ''}`)
    const text = rows.length ? `Stored secrets (backend: ${backend}):\n${rows.join('\n')}` : 'No secrets stored yet. Use request_secret.'
    return { result: text }
  })

  on('tool.call', { tool: 'mcp__shhstore__write_secret_to_env' }, async ($, e) => {
    const input = e as unknown as { name?: string; file?: string; var?: string }
    const name = normName(input.name ?? '')
    const value = secrets.get(name)
    if (value === undefined) return { deny: `No secret named ${name}. Call list_secrets or request_secret.` }
    const varName = (input.var ?? name).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(varName)) return { deny: `Bad variable name "${varName}".` }
    if (!input.file) return { deny: 'file is required.' }
    try {
      const msg = await envSet($, input.file, varName, name, value)
      return { result: msg }
    } catch (err) {
      return { deny: `Could not write ${input.file}: ${redactString(String(err))}` }
    }
  })

  on('tool.call', { tool: 'mcp__shhstore__delete_secret' }, async ($, e) => {
    const name = normName((e as unknown as { name?: string }).name ?? '')
    if (!secrets.has(name)) return { deny: `No secret named ${name}.` }
    const answer = await $.ui.ask(`Delete secret ${name} from the keychain?`, ['Keep it', 'Delete']).catch(() => 'Keep it')
    if (answer !== 'Delete') return { deny: 'The user kept the secret.' }
    await removeSecret($, name)
    return { result: `Deleted ${name}.` }
  })

  // ── every other tool: expand placeholders on the way in, redact on the way out

  on('tool.call', async ($, e, next) => {
    if (e.tool.startsWith('mcp__shhstore__')) return next(e)

    let input = e
    const wanted = placeholdersIn(e)
    if (wanted.length > 0) {
      const missing = wanted.filter(n => !secrets.has(n))
      if (missing.length > 0 && (EXPANDING_TOOLS.has(e.tool) || e.tool.startsWith('mcp__'))) {
        return { deny: `Unknown secret(s): ${missing.join(', ')}. Call mcp__shhstore__list_secrets or mcp__shhstore__request_secret.` }
      }
      if (EXPANDING_TOOLS.has(e.tool) || e.tool.startsWith('mcp__')) {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(e as unknown as Record<string, unknown>)) {
          out[k] = RESERVED_KEYS.has(k) ? v : deepMap(v, expandString)
        }
        input = out as unknown as typeof e
      }
    }

    const ran = await next(input)
    if ('deny' in ran && ran.deny !== undefined) return { deny: redactString(ran.deny) }
    if (!containsSecret(ran.result) && !(ran.text && redactString(ran.text) !== ran.text)) return ran

    if (ran.isError) {
      return { deny: redactString(ran.text ?? String(ran.result ?? 'error')) }
    }
    return { result: deepMap(ran.result, redactString) as typeof ran.result, context: ran.context }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'shhstore: the secrets guard failed, so the call was not run.' },
  )

  // ── injected attachments (changed-file diffs, @mentions, hook output) ────

  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    return r.text ? { ...r, text: redactString(r.text) } : r
  })

  // ── keys pasted straight into the prompt ─────────────────────────────────

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    let text = redactString(e.text)
    const found: { name: string; value: string }[] = []
    const taken = new Set<string>()
    const capture = (base: string, value: string) => {
      const name = nameForPasted(base, value, taken)
      taken.add(name)
      found.push({ name, value })
      return ph(name)
    }
    text = text.replace(ASSIGN_RE, (all: string, varName: string, _q: string, value: string) => {
      if (value.includes('{{shh:') || /^(your|xxx|<|\$\{|changeme|placeholder)/i.test(value)) return all
      return all.replace(value, capture(normName(varName), value))
    })
    for (const p of PATTERNS) text = text.replace(p.re, v => capture(p.name, v))

    if (found.length === 0) return text === e.text ? next(e) : next({ ...e, text })

    const saved: string[] = []
    for (const f of found) {
      if (secrets.get(f.name) === f.value) {
        saved.push(f.name)
        continue
      }
      try {
        await saveSecret($, f.name, f.value, 'pasted')
        saved.push(f.name)
      } catch (err) {
        return { drop: `shhstore: found a secret in your message but could not store it (${String(err).slice(0, 120)}). The message was NOT sent.` }
      }
    }
    $.ui.toast(`🔒 Intercepted ${saved.join(', ')} — stored in the ${backend}; Claude gets only the placeholder.`, { timeoutMs: 8000 })
    const note =
      `shhstore: the user's message contained secret value(s). They were stored and replaced with placeholders before you saw them: ${saved.map(ph).join(', ')}. ` +
      TOOL_GUIDE
    return next({ ...e, text, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) =>
    next.called ? next(e) : { drop: 'shhstore: the secret scan failed, so the message was not sent (it may contain a key). Try again, or use /secret NAME.' },
  )

  // ── slash commands ───────────────────────────────────────────────────────

  on('command.run', { command: 'secret' }, async ($, e) => {
    const [rawName, ...rest] = e.args.trim().split(/\s+/)
    const name = normName(rawName ?? '')
    if (!NAME_RE.test(name)) return { text: 'Usage: /secret NAME   (e.g. /secret OPENAI_API_KEY) — then paste the value in the field that opens.', isTextDisplayOnly: true }
    const extra = rest.length > 0 ? ' (Ignored the text after the name — never put the value on the command line.)' : ''
    void openInput($, name, undefined)
    return { text: `🔒 Paste the value for ${name} in the field above.${extra}`, isTextDisplayOnly: true }
  })

  on('command.run', { command: 'secrets' }, async $ => {
    const index = await getIndex($)
    const names = Object.keys(index).filter(n => secrets.has(n))
    const text = names.length
      ? `Stored secrets (${backend}):\n` + names.map(n => { const m = index[n]!; return `  ${n}  (${m.length} chars, ${m.source}, ${m.createdAt.slice(0, 10)})` }).join('\n')
      : 'No secrets stored. Use /secret NAME.'
    return { text, isTextDisplayOnly: true }
  })

  // ── the pane ─────────────────────────────────────────────────────────────

  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if ((e as unknown as { id: string }).id === PANE && waiter) {
      await update($, pendingAtom, () => null)
      finish({ ok: false, reason: 'The user cancelled the secret input.' })
    }
    return r
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Input, Button } = $.ui.resolve(e)
    const pending = await read($, pendingAtom)
    if (!pending) return <Text dimColor>No secret requested.</Text>
    return (
      <Box flexDirection="column">
        <Text bold>
          🔒 {pending.name}
          {secrets.has(pending.name) ? '  (replaces the stored value)' : ''}
        </Text>
        {pending.description ? <Text dimColor>{pending.description}</Text> : null}
        <Input
          key="value"
          label="value "
          placeholder="paste the key and press Enter"
          submitLabel="save"
          autoFocus
          onSubmit={v => void submitValue($, v, 'input')}
        />
        {pending.error ? <Text color="error">{pending.error}</Text> : null}
        <Text dimColor>Goes to the {backend}, never to the chat or the model. Esc cancels.</Text>
        {backend === 'keychain' ? (
          <Button
            key="dialog"
            label="Hidden input (macOS dialog)"
            onPress={async () => {
              const v = await askViaDialog($, pending.name, pending.description)
              if (v !== undefined) await submitValue($, v, 'dialog')
            }}
          />
        ) : null}
      </Box>
    )
  })
}
