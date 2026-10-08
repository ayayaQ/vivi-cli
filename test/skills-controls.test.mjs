// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArguments, main } from '../dist/main.js'
import { CliHost } from '../dist/host.js'
import { FileSkillStore } from '../dist/skills.js'
import { newSession } from '../dist/session.js'
import { runSkillsCommand } from '../dist/terminal.js'
const answer = () => ({ content: 'Drafted', toolCalls: [] })
const settings = { provider: 'openai', model: 'fake' }
const io = () => ({ output: '', results: [], lifecycle: [], runStarted() { this.lifecycle.push('started') }, runFinished() { this.lifecycle.push('finished') }, write(text) { this.output += text }, result(result) { this.results.push(result) }, onCancel() { return () => {} } })
async function fixture(t) { const dir = await realpath(await mkdtemp(join(tmpdir(), 'vivi-skills-controls-'))); t.after(() => rm(dir, { recursive: true, force: true })); return dir }
test('explicit roots are bounded launch-only flags, with no auto-discovery', () => {
  const options = parseArguments(['--model', 'fake', '--skills-dir', 'custom', '--skills-dir', '/other', '--no-skills', '--no-workspace'], {}, false, '/launch')
  assert.deepEqual(options.skillsDirectories, [resolve('/launch', 'custom'), resolve('/launch', '/other')])
  assert.equal(options.enableSkills, false); assert.equal(options.workspace, undefined)
  assert.deepEqual(parseArguments(['--model', 'fake'], {}, false, '/launch').skillsDirectories, [])
  assert.equal(parseArguments(['--model', 'fake'], {}).enableSkills, true)
  assert.throws(() => parseArguments(['--model', 'fake', ...Array(9).fill(['--skills-dir', '/explicit']).flat()], {}), /eight/)
})
test('line commands list, inspect, create through agent, toggle and refuse malformed commands', async t => {
  const dir = await fixture(t), skills = new FileSkillStore(join(dir, 'agent-skills')), output = io(), prompts = []
  const host = new CliHost({ skills, enableSkills: true, session: newSession(settings), store: { async save() {} }, provider: { async generate(input) { prompts.push(input.messages.at(-1).content); return answer() } } })
  await runSkillsCommand(host, output, '/skills'); assert.match(output.output, /skill-creator/)
  await runSkillsCommand(host, output, '/skills inspect skill-creator'); assert.match(output.output, /SKILL.md/)
  await runSkillsCommand(host, output, '/skills create make three-point summaries'); assert.deepEqual(output.lifecycle, ['started', 'finished']); assert.match(prompts[0], /skill-creator/); assert.match(prompts[0], /three-point/)
  await runSkillsCommand(host, output, '/skills off'); assert.equal(host.skillsEnabled, false)
  await runSkillsCommand(host, output, '/skills inspect skill-creator'); assert.match(output.output, /disabled/)
  await runSkillsCommand(host, output, '/skills on'); assert.equal(host.skillsEnabled, true)
  await runSkillsCommand(host, output, '/skills nonsense'); assert.equal(prompts.length, 1)
  assert.equal(await runSkillsCommand(host, output, 'ordinary message'), false)
  await skills.drain({ close: true })
})
test('interactive skills manager works before model setup and never sends inspection as a prompt', async t => {
  const dir = await fixture(t), lines = ['/skills', '/skills', '/exit'], choices = ['inspect', 'skill-creator', 'close', 'back', 'toggle', 'back']
  const output = io(); let providers = 0
  const interactive = { ...output, async readLine() { return lines.shift() }, async choose(_title, values) { const value = choices.shift(); assert(values.some(item => item.value === value)); return value },
    async chooseSearchable() {}, async askText() {}, setSession() {}, setDraft() {}, event() {}, async approve() { return false }, close() {} }
  assert.equal(await main(['--no-workspace'], { VIVI_SESSION_DIR: dir }, { tuiIO: interactive, providerFactory() { providers++; return { generate: async () => answer() } } }), 0)
  assert.equal(providers, 0); assert.match(interactive.output, /exact-source portion/); assert.equal(choices.length, 0)
})

for (const status of ['completed', 'error', 'cancelled']) test(`skill draft turn preserves run lifecycle on ${status}`, async () => {
  const output = io();
  const host = { async send() { return { status, history: [], rounds: 0, content: '', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } }, cancel() {}, skillsEnabled: true };
  await runSkillsCommand(host, output, '/skills create ordinary summary instructions');
  assert.deepEqual(output.lifecycle, ['started', 'finished']);
  assert.equal(output.results[0].status, status);
});

test('ordinary chat remains available with manually readable skills and with an unavailable owned collection', async t => {
  const dir = await fixture(t);
  const { mkdir, writeFile } = await import('node:fs/promises');
  const root = join(dir, 'agent-skills'); await mkdir(root, { mode: 0o755 });
  const folder = join(root, 'manual-guide'); await mkdir(folder, { mode: 0o755 });
  await writeFile(join(folder, 'SKILL.md'), '---\nname: manual-guide\ndescription: Summarize supplied text when requested.\n---\nReturn a short summary.\n', { mode: 0o644 });
  const output = { ...io(), async readLine() {}, event() {}, async approve() { return false }, close() {} };
  let calls = 0;
  assert.equal(await main(['--no-workspace', '--no-tools', '--model', 'fake', '--prompt', 'Ordinary request'], { VIVI_SESSION_DIR: dir }, {
    io: output, providerFactory: () => ({ async generate(input) { calls++; assert(input.messages.some(message => message.content.includes('manual-guide'))); assert.deepEqual(input.tools, []); return answer(); } })
  }), 0);
  assert.equal(calls, 1);
  await rm(root, { recursive: true }); await writeFile(root, 'Invalid collection remains untouched', { mode: 0o644 });
  assert.equal(await main(['--no-workspace', '--no-tools', '--model', 'fake', '--prompt', 'Another request'], { VIVI_SESSION_DIR: dir }, {
    io: output, providerFactory: () => ({ async generate(input) { calls++; assert(input.messages.some(message => message.content.includes('skill-creator'))); return answer(); } })
  }), 0);
  assert.equal(calls, 2); assert.match(output.output, /Owned skill folder unavailable/);
});

