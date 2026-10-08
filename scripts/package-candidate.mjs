// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const npmFields = ['id', 'name', 'version', 'size', 'unpackedSize', 'shasum', 'integrity',
  'filename', 'files', 'entryCount', 'bundled']
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex')
const keys = (value, expected) => {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Candidate metadata must be an object')
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Unexpected candidate metadata fields')
}

/** An imported candidate is a pair; exporting is reserved for a newly packed candidate. */
export function candidateOptions(env = process.env) {
  const values = ['VIVI_TEST_PACKAGE_ARCHIVE', 'VIVI_TEST_PACKAGE_METADATA', 'VIVI_TEST_CANDIDATE_DIR']
    .map(name => {
      const value = env[name]
      assert(value === undefined || typeof value === 'string' && value.length > 0 && value === value.trim(),
        `${name} must be a nonempty path`)
      return value === undefined ? undefined : resolve(value)
    })
  const [archive, metadata, directory] = values
  assert(Boolean(archive) === Boolean(metadata), 'Candidate archive and metadata must be supplied together')
  assert(!archive || !directory, 'An imported candidate cannot be exported as a new candidate')
  assert(!archive || archive !== metadata, 'Candidate archive and metadata must be separate files')
  return { archive, metadata, directory }
}

/** Bind normal npm pack metadata and both digests to the exact private archive bytes. */
export function validateCandidate(candidate, bytes, manifest, filename) {
  keys(candidate, ['schemaVersion', 'kind', 'artifact', 'npm'])
  assert.equal(candidate.schemaVersion, 1, 'Unsupported candidate metadata schema')
  assert.equal(candidate.kind, 'canonical-private-npm-candidate', 'Unexpected candidate metadata kind')
  keys(candidate.artifact, ['filename', 'size', 'sha256', 'sha512'])
  keys(candidate.npm, npmFields)
  const packed = candidate.npm
  assert.equal(manifest.private, true, 'Candidate must remain private')
  assert.equal(manifest.name, '@ayayaq/vivi-cli', 'Unexpected CLI package name')
  const expectedFilename = `ayayaq-vivi-cli-${manifest.version}.tgz`
  assert.equal(filename, expectedFilename, 'Candidate input filename mismatch')
  assert.equal(candidate.artifact.filename, expectedFilename, 'Candidate artifact filename mismatch')
  assert.equal(packed.filename, expectedFilename, 'Candidate npm filename mismatch')
  assert.equal(packed.name, manifest.name, 'Candidate npm package name mismatch')
  assert.equal(packed.version, manifest.version, 'Candidate npm package version mismatch')
  assert.equal(packed.id, `${manifest.name}@${manifest.version}`, 'Candidate npm package id mismatch')
  assert(Buffer.isBuffer(bytes) && bytes.length > 0, 'Candidate archive must contain bytes')
  assert(Number.isSafeInteger(candidate.artifact.size), 'Invalid candidate byte size')
  assert.equal(candidate.artifact.size, bytes.length, 'Candidate byte size mismatch')
  assert.equal(packed.size, bytes.length, 'Candidate npm byte size mismatch')
  assert.match(candidate.artifact.sha256, /^[a-f0-9]{64}$/, 'Invalid candidate SHA-256')
  assert.match(candidate.artifact.sha512, /^[a-f0-9]{128}$/, 'Invalid candidate SHA-512')
  assert.equal(candidate.artifact.sha256, digest('sha256', bytes), 'Candidate SHA-256 mismatch')
  assert.equal(candidate.artifact.sha512, digest('sha512', bytes), 'Candidate SHA-512 mismatch')
  assert.equal(packed.shasum, digest('sha1', bytes), 'Candidate npm shasum mismatch')
  assert.equal(packed.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    'Candidate npm integrity mismatch')
  assert(Array.isArray(packed.files) && packed.files.length > 0, 'Candidate npm file list is required')
  assert.equal(packed.entryCount, packed.files.length, 'Candidate npm entry count mismatch')
  let unpackedSize = 0
  const paths = new Set()
  for (const file of packed.files) {
    keys(file, ['path', 'size', 'mode'])
    assert(typeof file.path === 'string' && file.path.length > 0 &&
      !/[\\\x00-\x1f:]/.test(file.path) && file.path.split('/').every(part => part && part !== '.' && part !== '..'),
    'Unsafe candidate npm file path')
    assert(!paths.has(file.path), 'Duplicate candidate npm file path')
    paths.add(file.path)
    assert(Number.isSafeInteger(file.size) && file.size >= 0, 'Invalid candidate npm file size')
    assert(Number.isSafeInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777, 'Invalid candidate npm file mode')
    unpackedSize += file.size
  }
  assert(Number.isSafeInteger(packed.unpackedSize) && packed.unpackedSize === unpackedSize,
    'Candidate npm unpacked size mismatch')
  // npm lists the exact transitive bundle closure, not just the manifest's roots.
  // The reviewed 0.7.0 core adds the pinned YAML parser; no other bundle is allowed.
  assert.deepEqual(manifest.bundledDependencies, ['@ayayaq/vivi'], 'Candidate bundle roots mismatch')
  assert.deepEqual(packed.bundled, ['@ayayaq/vivi', 'yaml'], 'Candidate bundled dependencies mismatch')
  return candidate
}

export function createCandidate(packed, bytes, manifest) {
  const candidate = {
    schemaVersion: 1,
    kind: 'canonical-private-npm-candidate',
    artifact: { filename: packed.filename, size: bytes.length,
      sha256: digest('sha256', bytes), sha512: digest('sha512', bytes) },
    npm: packed
  }
  return validateCandidate(candidate, bytes, manifest, packed.filename)
}

async function regularFile(path, limit) {
  const stat = await lstat(path)
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Candidate input must be a regular file')
  assert(stat.size > 0 && stat.size <= limit, 'Candidate input file size is invalid')
  return readFile(path)
}

export async function readCandidate(archive, metadata, manifest) {
  const bytes = await regularFile(archive, 128 * 1024 * 1024)
  const candidate = JSON.parse(await regularFile(metadata, 2 * 1024 * 1024))
  validateCandidate(candidate, bytes, manifest, basename(archive))
  return { bytes, candidate }
}

/** Inspect the imported tar itself before installing; declared metadata alone is insufficient. */
export function verifyNpmMetadata(candidate, observed) {
  assert(Array.isArray(observed) && observed.length === 1, 'Expected exactly one npm archive')
  assert.deepEqual(observed[0], candidate.npm, 'Candidate metadata does not match the actual npm archive')
}

export async function requireNewCandidateDirectory(directory) {
  if (!directory) return
  try {
    await lstat(directory)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error('Candidate export directory must not already exist')
}

/** Called only after every consumer check passes; an incomplete candidate is never exposed. */
export async function exportCandidate(directory, { bytes, candidate, evidence, manifest }) {
  validateCandidate(candidate, bytes, manifest, candidate.artifact.filename)
  assert.deepEqual(evidence.artifact, { filename: candidate.artifact.filename,
    sha256: candidate.artifact.sha256, integrity: candidate.npm.integrity,
    size: bytes.length, cliVersion: manifest.version }, 'Candidate evidence artifact mismatch')
  await requireNewCandidateDirectory(directory)
  const staging = await mkdtemp(join(dirname(directory), '.vivi-cli-candidate-'))
  try {
    await writeFile(join(staging, candidate.artifact.filename), bytes, { flag: 'wx' })
    await writeFile(join(staging, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' })
    await writeFile(join(staging, 'package-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
    await requireNewCandidateDirectory(directory)
    await rename(staging, directory)
  } finally { await rm(staging, { recursive: true, force: true }) }
}

/** Windows checkout line endings may differ; no other legal text change is tolerated. */
export function normalizeLicense(bytes) {
  return Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
}
