// SPDX-License-Identifier: Apache-2.0
// Offline compiled-executable smoke check. Only synthetic fixture keys and tokens are used.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpOAuthStore } from '../../dist/mcp-oauth-store.js'
const endpoint = 'https://mcp.fixture.invalid/mcp'
const client = { id: 'fixture-client', issuer: 'https://auth.fixture.invalid', redirectPort: 9876, redirectPath: '/callback', scopes: ['read'] }
const credentials = { accessToken: 'fixture-secret-access', refreshToken: 'fixture-secret-refresh', expiresAt: 61_000,
  issuer: client.issuer, resource: endpoint, clientId: client.id, scopes: ['read'] }
const syntheticKey = Buffer.alloc(32, 17).toString('base64')
const keyStore = () => ({ status: async () => ({ available: true, label: 'Fixture keyring' }), load: async () => syntheticKey,
  save: async () => { throw Error('Unexpected fixture key save') } })
const flag = process.argv.indexOf('--hold')
if (flag !== -1) {
  const store = new McpOAuthStore(process.argv[flag + 1], { keyStore })
  await store.refreshTokens('example', endpoint, process.argv[flag + 2], async initial => {
    process.stdout.write('locked\n'); await new Promise(resolve => process.stdin.once('data', resolve)); return initial
  })
} else {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-compiled-mcp-oauth-fixture-'))
  let child, closed
  try {
    const store = new McpOAuthStore(directory, { keyStore }), clientRecord = await store.saveClient('example', endpoint, client)
    const record = await store.saveTokens('example', endpoint, clientRecord.revision, credentials)
    assert.equal((await new McpOAuthStore(directory, { keyStore }).load('example', endpoint)).tokens.accessToken, credentials.accessToken)
    child = spawn(process.execPath, ['--hold', directory, record.revision], { stdio: ['pipe', 'pipe', 'pipe'] })
    closed = new Promise(resolve => child.once('close', resolve))
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(Error(`fixture child exited ${code}`))) })
    await assert.rejects(store.clearTokens('example', endpoint), error => error.code === 'busy')
    child.kill('SIGKILL'); await closed
    assert.equal((await store.load('example', endpoint)).tokens, undefined)
    const fresh = await store.saveClient('example', endpoint, client)
    await store.saveTokens('example', endpoint, fresh.revision, { ...credentials, refreshToken: 'fixture-secret-fresh-refresh' })
    assert.equal((await store.load('example', endpoint)).tokens.refreshToken, 'fixture-secret-fresh-refresh')
    process.stdout.write('Compiled MCP saved-auth restart, crash recovery and lease smoke passed\n')
  } finally { child?.kill('SIGKILL'); await closed; await rm(directory, { recursive: true, force: true }) }
}
