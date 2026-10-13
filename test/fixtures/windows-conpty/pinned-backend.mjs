// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

export const pinnedRelease = 'v1.24.12741.0'
export const pinnedPackage = 'Microsoft.Windows.Console.ConPTY.1.24.261001001.nupkg'
export const pinnedArchiveSha256 = 'eceaafe3bdcc85e95d18666eb647e0b8e7e00af45dbcad7034cdc61c4a29fe74'
export const pinnedDownloadUrl = `https://github.com/microsoft/terminal/releases/download/${pinnedRelease}/${pinnedPackage}`
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export function validatePinnedProvenance(provenance) {
  assert.equal(provenance.release, pinnedRelease)
  assert.equal(provenance.package, pinnedPackage)
  assert.equal(provenance.archiveSha256, pinnedArchiveSha256)
  assert.equal(provenance.architecture, 'x64')
  assert.match(provenance.dllSha256, /^[a-f0-9]{64}$/)
  assert.match(provenance.serverSha256, /^[a-f0-9]{64}$/)
}

/** Verify the immutable official archive and each deterministic CI-extracted peer before loading code. */
export async function verifyPinnedBackend(directory) {
  assert.ok(directory && isAbsolute(directory), 'Pinned backend requires an absolute directory')
  const root = resolve(directory)
  for (const name of ['archive.nupkg', 'conpty.dll', 'OpenConsole.exe', 'provenance.json']) {
    const info = await lstat(join(root, name))
    assert.equal(info.isFile(), true, 'Pinned backend peer must be a regular file')
    const maximum = name === 'provenance.json' ? 16384 : name === 'archive.nupkg' ? 4194304 : 33554432
    assert.ok(info.size > 0 && info.size <= maximum, 'Pinned backend peer exceeded its bounded file budget')
  }
  const archive = await readFile(join(root, 'archive.nupkg'))
  assert.equal(hash(archive), pinnedArchiveSha256, 'Official pinned ConPTY archive hash mismatch')
  const provenance = JSON.parse(await readFile(join(root, 'provenance.json'), 'utf8'))
  validatePinnedProvenance(provenance)
  assert.equal(hash(await readFile(join(root, 'conpty.dll'))), provenance.dllSha256, 'Pinned DLL changed after extraction')
  assert.equal(hash(await readFile(join(root, 'OpenConsole.exe'))), provenance.serverSha256, 'Pinned server changed after extraction')
  return { directory: root, provenance }
}
