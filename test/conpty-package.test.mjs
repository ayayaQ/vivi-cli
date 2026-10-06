// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pinnedArchiveSha256, pinnedDownloadUrl, pinnedPackage, pinnedRelease,
  validatePinnedProvenance, verifyPinnedBackend } from './fixtures/windows-conpty/pinned-backend.mjs'

const metadata = () => ({ release: pinnedRelease, package: pinnedPackage, archiveSha256: pinnedArchiveSha256,
  architecture: 'x64', dllSha256: '1'.repeat(64), serverSha256: '2'.repeat(64) })

test('pinned backend provenance names one exact official Microsoft release and digest', () => {
  assert.equal(pinnedDownloadUrl, 'https://github.com/microsoft/terminal/releases/download/v1.24.12741.0/Microsoft.Windows.Console.ConPTY.1.24.261001001.nupkg')
  assert.equal(pinnedArchiveSha256.length, 64)
  assert.doesNotThrow(() => validatePinnedProvenance(metadata())) // Schema only; loading also verifies actual bytes.
  for (const field of ['release', 'package', 'archiveSha256', 'architecture', 'dllSha256', 'serverSha256']) {
    assert.throws(() => validatePinnedProvenance({ ...metadata(), [field]: 'unexpected' }))
  }
})

test('pinned backend rejects absent or relative selection before reading code', async () => {
  await assert.rejects(verifyPinnedBackend(undefined), /absolute directory/)
  await assert.rejects(verifyPinnedBackend('relative-directory'), /absolute directory/)
})

test('pinned backend rejects changed archive bytes even with plausible provenance and both peers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-conpty-package-rejection-'))
  try {
    for (const file of ['archive.nupkg', 'conpty.dll', 'OpenConsole.exe']) await writeFile(join(directory, file), 'known nonexecutable fixture')
    await writeFile(join(directory, 'provenance.json'), JSON.stringify(metadata()))
    await assert.rejects(verifyPinnedBackend(directory), /archive hash mismatch/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
