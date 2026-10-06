// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { main, parseArguments, HELP } from '../dist/main.js'
import { CliHost } from '../dist/host.js'
import { FileSessionStore } from '../dist/session.js'
import { WORKSPACE_TOOL_NAMES } from '../dist/workspace.js'

const reply = { content: 'Done', toolCalls: [] }
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-launch-workspace-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const project = join(directory, 'launch project 日本語'), other = join(project, 'other'), state = join(directory, 'private-state')
  await mkdir(other, { recursive: true })
  await writeFile(join(project, 'readme.txt'), 'Launch folder fixture')
  await writeFile(join(other, 'readme.txt'), 'Override folder fixture')
  return { directory, project, other, state }
}
function fakeIO(lines = []) {
  return { output: '', results: [], sessions: [], folders: [], closed: false,
    get isClosed() { return this.closed },
    async readLine() { return lines.shift() }, write(value) { this.output += value }, event() {},
    result(value) { this.results.push(value) }, async approve() { throw new Error('Read-only tools do not seek approval') },
    onCancel() { return () => {} }, close() { this.closed = true },
    setSession(value) { this.sessions.push(value) }, setDraft() {}, setWorkspace(value) { this.folders.push(value) },
    async choose() { return undefined }, async chooseSearchable() { return undefined }, async askText() { return undefined }
  }
}
const services = { credentials: { async status() { return { available: false, label: 'Fixture vault' } }, async load() { return undefined } },
  catalog: { async list() { throw new Error('No catalog request expected') } } }
function reader(expected, captures = []) {
  let rounds = 0
  return (_session, options) => ({ async generate(input) {
    captures.push({ input, workspace: options.workspace })
    assert(input.tools.some(tool => tool.name === 'workspace_read'))
    if (++rounds % 2 === 1) return { content: '', toolCalls: [{ id: `read-${rounds}`, name: 'workspace_read', arguments: { path: 'readme.txt' } }] }
    assert.equal(JSON.parse(input.messages.at(-1).content).content, expected)
    return reply
  } })
}

test('CLI parsing uses its captured launch folder, explicit overrides and an unambiguous opt-out', () => {
  const cwd = resolve('launch-fixture')
  const args = ['--model', 'fixture']
  assert.equal(parseArguments(args, { VIVI_WORKSPACE: '/unused', PWD: '/unused' }, false, cwd).workspace, cwd)
  assert.equal(parseArguments([...args, '--workspace', 'other'], {}, false, cwd).workspace, join(cwd, 'other'))
  assert.equal(parseArguments([...args, '--workspace', '..'], {}, false, cwd).workspace, dirname(cwd))
  assert.equal(parseArguments([...args, '--workspace', resolve('elsewhere')], {}, false, cwd).workspace, resolve('elsewhere'))
  assert.equal(parseArguments([...args, '--workspace', 'one', '--workspace', 'two'], {}, false, cwd).workspace, join(cwd, 'two'))
  assert.equal(parseArguments([...args, '--no-workspace', '--no-workspace'], {}, false, cwd).workspace, undefined)
  for (const flags of [['--workspace', 'other', '--no-workspace'], ['--no-workspace', '--workspace', 'other']]) {
    assert.throws(() => parseArguments([...args, ...flags], {}, false, cwd), /either --workspace PATH or --no-workspace/)
  }
  assert.equal(parseArguments(args, {}).workspace, undefined)
  assert.match(HELP, /default: launch directory/); assert.match(HELP, /--no-workspace/)
  assert(!HELP.includes('Workspace reads are off by default'))
  if (process.platform === 'win32') {
    assert.equal(parseArguments([...args, '--workspace', 'D:\\Other Folder'], {}, false, 'C:\\Launch Folder').workspace, 'D:\\Other Folder')
    assert.equal(parseArguments([...args, '--workspace', '..\\Other Folder'], {}, false, 'C:\\Launch Folder').workspace, 'C:\\Other Folder')
  }
})

for (const surface of ['line-chat', 'line-prompt', 'tui-chat', 'tui-prompt']) {
  test(`${surface} uses the launch folder without an explicit workspace flag`, async t => {
    const { project, state } = await fixture(t), io = fakeIO(['Read fixture', '/exit']), captures = []
    const args = ['--model', 'fixture', '--tools', '--session-dir', state,
      ...(surface.endsWith('prompt') ? ['--prompt', 'Read fixture'] : []), ...(surface.startsWith('line') ? ['--no-tui'] : [])]
    const code = await main(args, {}, { ...(surface.startsWith('line') ? { io } : { tuiIO: io, ...services }),
      launchDirectory: project, providerFactory: reader('Launch folder fixture', captures) })
    assert.equal(code, 0); assert.equal(captures.length, 2)
    assert.equal(captures[0].workspace, project)
    assert(io.output.includes(`Workspace: ${JSON.stringify(await realpath(project))}`))
    assert.match(io.output, /sent to the selected provider and saved in session history/)
    if (surface.startsWith('tui')) assert.deepEqual(io.folders, [await realpath(project)])
    for (const file of (await readdir(state)).filter(file => file.endsWith('.json'))) {
      const saved = await readFile(join(state, file), 'utf8')
      assert(!saved.includes(project)); assert(!saved.includes('"workspace"'))
    }
  })
}

test('explicit relative override takes precedence over launch cwd for a line prompt', async t => {
  const { project, other, state } = await fixture(t), io = fakeIO(), captures = []
  assert.equal(await main(['--no-tui', '--model', 'fixture', '--tools', '--workspace', 'other', '--session-dir', state, '--prompt', 'Read'], {},
    { io, launchDirectory: project, providerFactory: reader('Override folder fixture', captures) }), 0)
  assert.equal(captures[0].workspace, other)
  assert(io.output.includes(JSON.stringify(await realpath(other))))
})

for (const flags of [['--no-workspace', '--tools'], ['--no-tools'], []]) {
  test(`launch cwd respects ${flags.join(' ') || 'unknown model capability'} without reading files`, async t => {
    const { project, state } = await fixture(t), io = fakeIO()
    // A corrupt ignore file would fail any workspace tool traversal/read.
    await writeFile(join(project, '.gitignore'), 'x'.repeat(40 * 1024))
    let calls = 0
    assert.equal(await main(['--no-tui', '--model', 'fixture', '--session-dir', state, '--prompt', 'Hello', ...flags], {},
      { io, launchDirectory: project, providerFactory: (_session, options) => ({ async generate({ tools, messages }) {
        calls++; assert(!tools.some(tool => WORKSPACE_TOOL_NAMES.includes(tool.name)))
        assert(!messages.some(message => /Workspace tools read/.test(message.content)))
        assert.equal(options.workspace, flags.includes('--no-workspace') ? undefined : project)
        return reply
      } }) }), 0)
    assert.equal(calls, 1)
    if (flags.includes('--no-workspace')) assert(!io.output.includes('Workspace:'))
    else assert.match(io.output, /tools unavailable/)
  })
}

test('failed default or override roots stop before providers; opt-out never opens a folder', async t => {
  const { directory, project, state } = await fixture(t)
  const roots = [join(directory, 'missing'), join(project, 'readme.txt'), parse(project).root, state]
  await mkdir(state, { mode: 0o700 })
  for (const root of roots) {
    let calls = 0
    assert.equal(await main(['--no-tui', '--model', 'fixture', '--session-dir', state, '--prompt', 'Hello'], {},
      { io: fakeIO(), launchDirectory: root, providerFactory() { calls++; return { generate: async () => reply } } }), 1)
    assert.equal(calls, 0)
  }
  assert.equal(await main(['--no-tui', '--no-workspace', '--model', 'fixture', '--session-dir', state, '--prompt', 'Hello'], {},
    { io: fakeIO(), launchDirectory: join(directory, 'missing'), providerFactory: () => ({ generate: async () => reply }) }), 0)
  let calls = 0
  assert.equal(await main(['--no-tui', '--model', 'fixture', '--workspace', 'missing', '--session-dir', state, '--prompt', 'Hello'], {},
    { io: fakeIO(), launchDirectory: project, providerFactory() { calls++; return { generate: async () => reply } } }), 1)
  assert.equal(calls, 0)
})

test('a default workspace protects custom session state inside it', async t => {
  const { project } = await fixture(t), state = join(project, 'private-profile'), io = fakeIO()
  let rounds = 0
  assert.equal(await main(['--no-tui', '--model', 'fixture', '--tools', '--session-dir', state, '--prompt', 'List'], {},
    { io, launchDirectory: project, providerFactory: () => ({ async generate({ messages }) {
      if (++rounds === 1) return { content: '', toolCalls: [{ id: 'list', name: 'workspace_list', arguments: {} }] }
      const paths = JSON.parse(messages.at(-1).content).entries.map(entry => entry.path)
      assert(!paths.some(path => path.includes('private-profile'))); assert(paths.includes('readme.txt'))
      return reply
    } }) }), 0)
})

test('new and resumed conversations use their current launch root without storing folder trust', async t => {
  const { project, other, state } = await fixture(t), io = fakeIO(['Read', '/new', 'Read again', '/session', '/exit']), captures = []
  assert.equal(await main(['--model', 'fixture', '--tools', '--session-dir', state], {},
    { tuiIO: io, ...services, launchDirectory: project, providerFactory: reader('Launch folder fixture', captures) }), 0)
  assert.equal(new Set(io.sessions.map(session => session.id)).size, 2)
  assert(captures.every(capture => capture.workspace === project))
  assert.equal(io.output.match(/Workspace:/g).length, 2)
  const sessionId = io.sessions.at(-1).id, resumed = fakeIO(), resumeCaptures = []
  assert.equal(await main(['--no-tui', '--resume', sessionId, '--tools', '--session-dir', state, '--prompt', 'Read current folder'], {},
    { io: resumed, launchDirectory: other, providerFactory: reader('Override folder fixture', resumeCaptures) }), 0)
  assert.equal(resumeCaptures[0].workspace, other)
})

test('library host construction does not add ambient working-directory tools', async t => {
  const { state } = await fixture(t)
  const host = await CliHost.create({ settings: { provider: 'openai', model: 'fixture' }, store: new FileSessionStore(state),
    provider: { async generate({ tools, messages }) {
      assert(!tools.some(tool => WORKSPACE_TOOL_NAMES.includes(tool.name)))
      assert(!messages.some(message => /Workspace tools read/.test(message.content)))
      return reply
    } } })
  assert.equal((await host.send('Hello')).status, 'completed')
})

async function runChild(executable, args, options) {
  const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => child.kill(), 10000)
  try { return await new Promise((resolve_, reject) => {
    child.once('error', reject); child.once('exit', code => resolve_({ code, stdout, stderr }))
  }) } finally { clearTimeout(timer) }
}

test('real Node launcher uses child launch cwd outside the install path and ignores PWD/profile', async t => {
  const { directory, project, state } = await fixture(t)
  const provider = join(directory, 'fake-provider.mjs'), hooks = join(directory, 'hooks.mjs'), register = join(directory, 'register.mjs')
  await writeFile(provider, `import assert from 'node:assert/strict'; export function createOpenAIProvider() { let rounds=0; return { async generate({tools,messages}) {
    assert(tools.some(tool=>tool.name==='workspace_read'));
    if (++rounds===1) return {content:'',toolCalls:[{id:'read',name:'workspace_read',arguments:{path:'readme.txt'}}]};
    assert.equal(JSON.parse(messages.at(-1).content).content,'Launch folder fixture'); return {content:'Launcher fixture accepted',toolCalls:[]};
  }} }`)
  await writeFile(hooks, `export function resolve(specifier,context,next) { return specifier==='@ayayaq/vivi/providers/openai'
    ? {url:new URL('./fake-provider.mjs',import.meta.url).href,shortCircuit:true} : next(specifier,context) }`)
  await writeFile(register, `import { register } from 'node:module'; register(new URL('./hooks.mjs',import.meta.url))`)
  const launcher = fileURLToPath(new URL('../dist/launcher.js', import.meta.url))
  const result = await runChild(process.execPath, ['--import', pathToFileURL(register).href, launcher, '--no-tui', '--model', 'gpt-5.1', '--prompt', 'Read fixture'], {
    cwd: project, env: { PATH: process.env.PATH, VIVI_SESSION_DIR: state, OPENAI_API_KEY: 'fixture-only-key', PWD: directory }
  })
  assert.equal(result.code, 0, result.stderr + result.stdout)
  assert(result.stdout.includes(JSON.stringify(await realpath(project))))
  assert.match(result.stdout, /Launcher fixture accepted/)
})

test('cwd is captured before async TUI credential setup and remains fixed after child chdir', async t => {
  const { project, other, state } = await fixture(t)
  const module = new URL('../dist/main.js', import.meta.url).href
  const script = `import assert from 'node:assert/strict'; import {realpath} from 'node:fs/promises'; import {main} from ${JSON.stringify(module)};
    const launch=process.cwd(),canonical=await realpath(launch); let captured,output=''; const lines=['Hello','/exit']; const io={closed:false, get isClosed(){return this.closed},
    readLine:async()=>lines.shift(),write(text){output+=text},event(){},result(){},approve:async()=>false,onCancel:()=>()=>{},close(){this.closed=true},
    setSession(){},setDraft(){},setWorkspace(value){assert.equal(value,canonical)},choose:async()=>undefined,chooseSearchable:async()=>undefined,askText:async()=>undefined};
    const code=await main(['--model','fixture','--tools'], {VIVI_SESSION_DIR:${JSON.stringify(state)}}, {tuiIO:io,
      credentials:{status:async()=>({available:false,label:'fixture'}),load:async()=>{process.chdir(${JSON.stringify(other)});return undefined}},
      providerFactory:(_session,options)=>{captured=options.workspace;return {generate:async()=>({content:'Done',toolCalls:[]})}}});
    assert.equal(code,0,output);assert.equal(captured,launch);console.log('Captured launch cwd passed')`
  const result = await runChild(process.execPath, ['--input-type=module', '-e', script], { cwd: project, env: { PATH: process.env.PATH } })
  assert.equal(result.code, 0, result.stderr + result.stdout); assert.match(result.stdout, /Captured launch cwd passed/)
})

test('help and explicit workspace opt-out still work from a deleted launch directory', { skip: process.platform === 'win32' }, async t => {
  const { project, state } = await fixture(t), module = new URL('../dist/main.js', import.meta.url).href
  const script = `import assert from 'node:assert/strict'; import {rm} from 'node:fs/promises'; import {main} from ${JSON.stringify(module)};
    const cwd=process.cwd();await rm(cwd,{recursive:true}); const io=()=>({output:'',readLine:async()=>undefined,
      write(text){this.output+=text},event(){},result(){},approve:async()=>false,onCancel:()=>()=>{},close(){}});
    const help=io(); assert.equal(await main(['--help'],{}, {io:help}),0);assert(help.output.includes('--no-workspace'));
    const chat=io(); assert.equal(await main(['--no-workspace','--no-tui','--model','fixture','--prompt','Hello'],
      {VIVI_SESSION_DIR:${JSON.stringify(state)}},{io:chat,providerFactory:()=>({generate:async()=>({content:'Done',toolCalls:[]})})}),0);
    console.log('Deleted cwd help and opt-out passed')`
  const result = await runChild(process.execPath, ['--input-type=module', '-e', script], { cwd: project, env: { PATH: process.env.PATH } })
  assert.equal(result.code, 0, result.stderr + result.stdout); assert.match(result.stdout, /Deleted cwd help and opt-out passed/)
})

test('TUI opt-out disables active folder status without opening an invalid launch directory', async t => {
  const { directory, state } = await fixture(t), io = fakeIO(['Hello', '/exit'])
  assert.equal(await main(['--no-workspace', '--model', 'fixture', '--tools', '--session-dir', state], {}, {
    tuiIO: io, ...services, launchDirectory: join(directory, 'missing'),
    providerFactory: (_session, options) => ({ async generate({ tools }) {
      assert.equal(options.workspace, undefined)
      assert(!tools.some(tool => WORKSPACE_TOOL_NAMES.includes(tool.name)))
      return reply
    } })
  }), 0)
  assert.deepEqual(io.folders, [undefined]); assert(!io.output.includes('Workspace:'))
})
