// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryExtension } from '@ayayaq/vivi/extensions/memory'
import { createSkillCatalog, createSkillsExtension } from '@ayayaq/vivi/extensions/skills'
import { createQuestionExtension } from '@ayayaq/vivi/extensions/questions'
import { createBuiltinToolset, BUILTIN_TOOL_OUTCOME_POLICIES } from '../dist/tools.js'
import { createWorkspaceExtension } from '../dist/workspace.js'
import { createCommandExtension } from '../dist/commands.js'
import { createMcpExtension } from '../dist/mcp-tools.js'
import { createMcpSetupExtension } from '../dist/mcp-setup-tools.js'
import { collectMcpCategory } from '../dist/mcp-catalog.js'
import { createPublicUrlExtension } from '../dist/public-url-tools.js'
const inert = () => { assert.fail('Inventory must never execute a tool') }
const signal = () => new AbortController().signal
async function packs(save = false) {
  const categories = Object.fromEntries(await Promise.all([
    ['tools', { tools: [{ name: 'arbitrary_tool', inputSchema: { type: 'object' } }] }],
    ['resources', { resources: [{ name: 'Document', uri: 'fixture:///document' }] }],
    ['resourceTemplates', { resourceTemplates: [{ name: 'Template', uriTemplate: 'fixture:///{name}' }] }]
  ].map(async ([kind, body]) => [kind, await collectMcpCategory('fixture', kind, async () => body, signal())])))
  const snapshot = { serverId: 'fixture', configRevision: 'a'.repeat(64), connectionGeneration: 'owned-generation',
    protocolVersion: '2025-11-25', catalogGeneration: 1, categories }
  return {
    memory: createMemoryExtension({ listMemories: inert, executeMutation: inert }),
    workspace: createWorkspaceExtension({}, [], inert, inert),
    skills: createSkillsExtension({ catalog: createSkillCatalog([]), authorizeRead: inert, ...(save ? { save: { authorize: inert, commit: inert } } : {}) }),
    commands: createCommandExtension(inert, inert),
    mcp: createMcpExtension({ captureCatalogs: inert, prepareOperation: inert }, [snapshot], inert),
    publicUrl: createPublicUrlExtension(inert),
    questions: createQuestionExtension({ ask: inert }),
    setup: createMcpSetupExtension({ listLocal: inert, executeSetup: inert })
  }
}
test('every actual registered owned tool has an explicit outcome policy, including conditional MCP resources', async () => {
  for (const save of [true, false]) {
  const p = await packs(save)
  for (const taskMode of ['execute', 'plan']) for (const notes of [true, false]) {
    const set = createBuiltinToolset(notes, [], p.memory, p.workspace, p.skills, p.commands, p.mcp, p.publicUrl, taskMode, p.questions, p.setup)
    try {
      assert.equal(set.tools.some(tool => tool.name === 'save_skill'), save && taskMode === 'execute', 'Skill saving requires an enabled owned capability and Execute mode')
      assert.equal(set.outcomePolicies.size, set.tools.length)
      const mcp = new Set(p.mcp.tools.map(tool => tool.definition.name))
      for (const tool of set.tools) {
        const policy = set.outcomePolicies.get(tool.name)
        assert.notEqual(policy, 'extension', `Owned tool silently fell into the imported extension fallback: ${tool.name}`)
        assert.equal(policy, mcp.has(tool.name) && tool.name !== 'list_mcp_resources' ? 'mcp' : BUILTIN_TOOL_OUTCOME_POLICIES[tool.name], `Missing explicit owned policy: ${tool.name}`)
      }
      if (taskMode === 'execute' && notes) {
        const staticNames = set.tools.map(tool => tool.name).filter(name => !mcp.has(name)).sort()
        assert.deepEqual(staticNames, Object.keys(BUILTIN_TOOL_OUTCOME_POLICIES).filter(name => name !== 'web_search' && !mcp.has(name) && (save || name !== 'save_skill')).sort())
        assert(['list_mcp_resources', 'read_mcp_resource', 'read_mcp_resource_template'].every(name => mcp.has(name)))
        assert([...mcp].some(name => !Object.hasOwn(BUILTIN_TOOL_OUTCOME_POLICIES, name)), 'Dynamic remote aliases are covered by owned provenance')
      }
    } finally { await set.dispose() }
  }
  }
})
test('a newly registered owned name fails closed instead of inheriting generic success evidence', async () => {
  const future = { id: 'owned.future-fixture', apiVersion: 1, tools: [{ definition: { name: 'future_builtin',
    description: 'Inventory regression fixture', parameters: { type: 'object' } }, validateArguments() {}, execute: inert }] }
  assert.throws(() => createBuiltinToolset(false, [], future), /no outcome policy/)
  const imported = createBuiltinToolset(false, [future])
  try { assert.equal(imported.outcomePolicies.get('future_builtin'), 'extension') }
  finally { await imported.dispose() }
})
