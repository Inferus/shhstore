import { expect, mock, test } from 'claude-code/testing'

const KEY = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0'

// A fake macOS keychain behind `$.process.run`, plus a fake file system.
function fakeHost(on: any) {
  const keychain = new Map<string, string>()
  const files = new Map<string, string>()
  const ran: string[][] = []
  mock.store(on)
  mock.clock(on)

  on('process.run', (_: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    const [bin, cmd, ...rest] = e.argv
    ran.push([...e.argv])
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const fail = () => ({ value: { exitCode: 44, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } })
    if (bin === '/usr/bin/security' && cmd === 'list-keychains') return ok()
    if (bin === '/usr/bin/security' && cmd === '-i') {
      const m = /-a (\S+) .*-w "((?:[^"\\]|\\.)*)"/.exec(e.init?.stdin ?? '')
      if (!m) return fail()
      keychain.set(m[1]!, m[2]!.replace(/\\(.)/g, '$1'))
      return ok()
    }
    if (bin === '/usr/bin/security' && cmd === 'find-generic-password') {
      const name = rest[rest.indexOf('-a') + 1]!
      return keychain.has(name) ? ok(keychain.get(name) + '\n') : fail()
    }
    if (bin === 'git') return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return ok()
  })
  // The engine hands fs hooks absolute paths; the fake keeps the relative ones.
  const rel = (p: string) => [...files.keys()].find(k => p === k || p.endsWith('/' + k)) ?? p.replace(/^.*\/shhstore\//, '')
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: files.has(rel(e.path)) }))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: files.get(rel(e.path)) ?? '' }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    files.set(rel(e.path), e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('tool.register', (_: unknown, e: { name: string }) => ({ value: { tool: `mcp__shhstore__${e.name}` } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return { keychain, files, ran }
}

async function start($: any) {
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
}

test('a key pasted into the prompt is stored and replaced by a placeholder', async ($, on) => {
  const host = fakeHost(on)
  let reached: { text: string; context?: readonly string[] } | undefined
  on('prompt.submit', (_, e) => {
    reached = { text: e.text, context: e.context }
    return { text: e.text, context: e.context }
  })
  await start($)

  await $.prompt.submit({ text: `here's my key ${KEY}, hook up openai` } as any)

  expect(reached?.text).toBe("here's my key {{shh:OPENAI_API_KEY}}, hook up openai")
  expect(reached?.text.includes(KEY)).toBe(false)
  expect((reached?.context ?? []).join('\n').includes('{{shh:OPENAI_API_KEY}}')).toBe(true)
  expect(host.keychain.get('OPENAI_API_KEY')).toBe(KEY)
})

test('.env lines pasted into the prompt are captured by variable name', async ($, on) => {
  const host = fakeHost(on)
  let text = ''
  on('prompt.submit', (_, e) => {
    text = e.text
    return { text: e.text }
  })
  await start($)

  await $.prompt.submit({ text: 'DATABASE_PASSWORD=hunter2hunter2\nDEBUG=true\nSTRIPE_KEY="abc def ghi jkl"' } as any)

  expect(text).toBe('DATABASE_PASSWORD={{shh:DATABASE_PASSWORD}}\nDEBUG=true\nSTRIPE_KEY="{{shh:STRIPE_KEY}}"')
  expect(host.keychain.get('DATABASE_PASSWORD')).toBe('hunter2hunter2')
  expect(host.keychain.get('STRIPE_KEY')).toBe('abc def ghi jkl')
})

test('placeholders expand going into Bash and the value is redacted coming out', async ($, on) => {
  fakeHost(on)
  let command = ''
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', (_, e: any) => {
    command = e.command
    return { result: { stdout: `got ${KEY}\n`, stderr: '', interrupted: false } }
  })
  await start($)
  await $.prompt.submit({ text: KEY } as any)

  const r: any = await $.tool.call({ tool: 'Bash', command: 'echo "{{shh:OPENAI_API_KEY}}"' })

  expect(command).toBe(`echo "${KEY}"`)
  expect(JSON.stringify(r).includes(KEY)).toBe(false)
  expect(r.result.stdout).toBe('got {{shh:OPENAI_API_KEY}}\n')
})

test('an unknown placeholder is refused instead of written literally', async ($, on) => {
  fakeHost(on)
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: {} }
  })
  await start($)

  const r: any = await $.tool.call({ tool: 'Write', file_path: '/p/.env', content: 'X={{shh:NOPE}}' })

  expect(ran).toBe(false)
  expect(String(r.deny ?? r.text).includes('NOPE')).toBe(true)
})

test('write_secret_to_env upserts the line and keeps the rest of the file', async ($, on) => {
  const host = fakeHost(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await start($)
  await $.prompt.submit({ text: KEY } as any)
  host.files.set('.env', '# app\nPORT=3000\nOPENAI_API_KEY=old\n')

  const r: any = await $.tool.call({ tool: 'mcp__shhstore__write_secret_to_env', name: 'OPENAI_API_KEY', file: '.env' } as any)

  expect(host.files.get('.env')).toBe(`# app\nPORT=3000\nOPENAI_API_KEY=${KEY}\n`)
  expect(JSON.stringify(r).includes(KEY)).toBe(false)

  await $.tool.call({ tool: 'mcp__shhstore__write_secret_to_env', name: 'OPENAI_API_KEY', file: 'web/.env.local', var: 'NEXT_PUBLIC_X' } as any)
  expect(host.files.get('web/.env.local')).toBe(`NEXT_PUBLIC_X=${KEY}\n`)
})

test('request_secret opens the pane, the typed value is stored, the model gets only the name', async ($, on) => {
  const host = fakeHost(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', (_: unknown, e: any) => ({ value: undefined }))
  await start($)

  const call: Promise<any> = $.tool.call({ tool: 'mcp__shhstore__request_secret', name: 'openai_api_key', description: 'platform.openai.com' } as any)
  await new Promise(r => (globalThis as any).setTimeout(r, 20))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'shhstore',
      component: 'Pane',
      requestId: 'shh-input',
      surface,
      props: { title: 'x', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 10 }, view: {} },
    } as any)
    expect((await ui.find({ type: 'Text', text: /OPENAI_API_KEY/ }))?.text.includes('OPENAI_API_KEY')).toBe(true)
    if (surface === 'desktop') await ui.input({ key: 'value', text: `  ${KEY}\n` } as any)
    await ui.unmount()
  }

  const r = await call
  expect(host.keychain.get('OPENAI_API_KEY')).toBe(KEY)
  expect(JSON.stringify(r).includes(KEY)).toBe(false)
  expect(JSON.stringify(r).includes('Stored OPENAI_API_KEY')).toBe(true)
})

test('a backslash writes the placeholder literally instead of expanding it', async ($, on) => {
  fakeHost(on)
  let content = ''
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', (_, e: any) => {
    content = e.content
    return { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [] } }
  })
  await start($)
  await $.prompt.submit({ text: KEY } as any)

  await $.tool.call({ tool: 'Write', file_path: '/p/README.md', content: 'use \\{{shh:OPENAI_API_KEY}} or \\{{shh:NOPE}}' })

  expect(content).toBe('use {{shh:OPENAI_API_KEY}} or {{shh:NOPE}}')
})
