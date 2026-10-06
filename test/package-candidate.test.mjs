// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { candidateOptions, createCandidate, exportCandidate, normalizeLicense, readCandidate,
  requireNewCandidateDirectory, validateCandidate, verifyNpmMetadata } from '../scripts/package-candidate.mjs'
import { packageAcceptanceEvidence } from '../scripts/platform-acceptance.mjs'

const manifest = { name: '@ayayaq/vivi-cli', version: '0.1.0-dev.0', private: true,
  bundledDependencies: ['@ayayaq/vivi'], dependencies: { '@ayayaq/vivi': '0.6.0' } }
const filename = 'ayayaq-vivi-cli-0.1.0-dev.0.tgz'
const bytes = Buffer.from('exact private candidate bytes')
const packed = { id: `${manifest.name}@${manifest.version}`, name: manifest.name, version: manifest.version,
  size: bytes.length, unpackedSize: 123, shasum: createHash('sha1').update(bytes).digest('hex'),
  integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, filename,
  files: [{ path: 'package.json', size: 123, mode: 0o644 }], entryCount: 1, bundled: ['@ayayaq/vivi', 'yaml'] }
const fixture = () => createCandidate(structuredClone(packed), bytes, manifest)
const evidenceFor = candidate => packageAcceptanceEvidence({ filename, sha256: candidate.artifact.sha256,
  integrity: candidate.npm.integrity, size: bytes.length, cliVersion: manifest.version, node: 'v26.4.0', bun: '1.4.2' })

test('candidate options require a complete import pair and keep fresh exports separate', () => {
  assert.deepEqual(candidateOptions({}), { archive: undefined, metadata: undefined, directory: undefined })
  assert.deepEqual(candidateOptions({ VIVI_TEST_PACKAGE_ARCHIVE: filename, VIVI_TEST_PACKAGE_METADATA: 'candidate.json' }),
    { archive: resolve(filename), metadata: resolve('candidate.json'), directory: undefined })
  assert.equal(candidateOptions({ VIVI_TEST_CANDIDATE_DIR: 'candidate' }).directory, resolve('candidate'))
  for (const env of [{ VIVI_TEST_PACKAGE_ARCHIVE: filename }, { VIVI_TEST_PACKAGE_METADATA: 'candidate.json' },
    { VIVI_TEST_PACKAGE_ARCHIVE: 'same', VIVI_TEST_PACKAGE_METADATA: 'same' },
    { VIVI_TEST_PACKAGE_ARCHIVE: filename, VIVI_TEST_PACKAGE_METADATA: 'candidate.json', VIVI_TEST_CANDIDATE_DIR: 'out' },
    { VIVI_TEST_CANDIDATE_DIR: '' }, { VIVI_TEST_PACKAGE_ARCHIVE: ' padded ' }, { VIVI_TEST_PACKAGE_METADATA: 123 }]) {
    assert.throws(() => candidateOptions(env))
  }
})

test('candidate metadata binds private identity, size, SHA256/SHA512 and normal npm digests', () => {
  const candidate = fixture()
  assert.equal(validateCandidate(candidate, bytes, manifest, filename), candidate)
  const mutations = [
    item => { item.schemaVersion = 2 }, item => { item.kind = 'release' }, item => { item.extra = true },
    item => { item.artifact.filename = '../other.tgz' }, item => { item.artifact.size++ },
    item => { item.artifact.sha256 = 'a'.repeat(64) }, item => { item.artifact.sha512 = 'b'.repeat(128) },
    item => { item.npm.name = '@other/cli' }, item => { item.npm.version = '0.2.0' },
    item => { item.npm.id = 'other@0.1.0' }, item => { item.npm.filename = 'other.tgz' },
    item => { item.npm.size++ }, item => { item.npm.shasum = 'a'.repeat(40) },
    item => { item.npm.integrity = 'sha512-bad' }, item => { item.npm.bundled = [] }
  ]
  for (const mutate of mutations) {
    const invalid = fixture()
    mutate(invalid)
    assert.throws(() => validateCandidate(invalid, bytes, manifest, filename))
  }
  assert.throws(() => validateCandidate(candidate, Buffer.from('changed bytes'), manifest, filename))
  assert.throws(() => validateCandidate(candidate, bytes, manifest, 'renamed.tgz'))
  assert.throws(() => validateCandidate(candidate, bytes, { ...manifest, private: false }, filename))
})

test('candidate npm file metadata rejects unsafe paths, duplicates, modes and inconsistent totals', () => {
  for (const path of ['../escape', '/absolute', 'C:/absolute', 'a\\b', 'a//b', './file', 'a/../b', 'a\0b']) {
    const candidate = fixture()
    candidate.npm.files[0].path = path
    assert.throws(() => validateCandidate(candidate, bytes, manifest, filename), /Unsafe/)
  }
  for (const mutate of [item => { item.npm.files.push({ ...item.npm.files[0] }); item.npm.entryCount++ },
    item => { item.npm.files[0].mode = 0o100644 }, item => { item.npm.files[0].size = -1 },
    item => { item.npm.files[0].extra = true }, item => { item.npm.entryCount++ },
    item => { item.npm.unpackedSize++ }, item => { item.npm.files = [] }]) {
    const candidate = fixture()
    mutate(candidate)
    assert.throws(() => validateCandidate(candidate, bytes, manifest, filename))
  }
})

test('actual npm archive inspection must exactly match all declared pack metadata', () => {
  const candidate = fixture()
  verifyNpmMetadata(candidate, [structuredClone(packed)])
  for (const observed of [[], [packed, packed], {}, [{ ...packed, entryCount: 2 }],
    [{ ...packed, files: [{ ...packed.files[0], mode: 0o755 }] }]]) {
    assert.throws(() => verifyNpmMetadata(candidate, observed))
  }
})

test('candidate imports read exact regular-file bytes and reject altered or malformed inputs', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'vivi-candidate-input-test-'))
  try {
    const archive = join(temporary, filename)
    const metadata = join(temporary, 'candidate.json')
    await writeFile(archive, bytes)
    await writeFile(metadata, JSON.stringify(fixture()))
    const imported = await readCandidate(archive, metadata, manifest)
    assert.deepEqual(imported.bytes, bytes)
    assert.deepEqual(imported.candidate, fixture())
    await writeFile(archive, Buffer.from('tampered candidate'))
    await assert.rejects(readCandidate(archive, metadata, manifest), /mismatch/)
    await writeFile(archive, bytes)
    await writeFile(metadata, '{malformed')
    await assert.rejects(readCandidate(archive, metadata, manifest), SyntaxError)
    await writeFile(metadata, Buffer.alloc(2 * 1024 * 1024 + 1, 32))
    await assert.rejects(readCandidate(archive, metadata, manifest), /file size/)
    await writeFile(metadata, JSON.stringify(fixture()))
    await assert.rejects(readCandidate(temporary, metadata, manifest), /regular file/)
    // Creating Windows symlinks needs elevated permissions; regular/directory coverage remains there.
    if (process.platform !== 'win32') {
      const link = join(temporary, 'link.json')
      await symlink(metadata, link)
      await assert.rejects(readCandidate(archive, link, manifest), /regular file/)
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('candidate export exposes only complete exact archive, pack metadata and nonsecret evidence', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'vivi-candidate-export-test-'))
  try {
    const directory = join(temporary, 'candidate')
    const candidate = fixture()
    await requireNewCandidateDirectory(directory)
    await exportCandidate(directory, { bytes, candidate, evidence: evidenceFor(candidate), manifest })
    assert.deepEqual((await readdir(directory)).sort(), [filename, 'candidate.json', 'package-evidence.json'].sort())
    assert.deepEqual(await readFile(join(directory, filename)), bytes)
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'candidate.json'))), candidate)
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'package-evidence.json'))), evidenceFor(candidate))
    await assert.rejects(exportCandidate(directory, { bytes, candidate, evidence: evidenceFor(candidate), manifest }), /already exist/)
    assert.deepEqual(await readFile(join(directory, filename)), bytes)
    assert.deepEqual(await readdir(temporary), ['candidate'])
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('failed candidate export cannot expose a directory or overwrite existing evidence', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'vivi-candidate-reject-test-'))
  try {
    const directory = join(temporary, 'candidate')
    const candidate = fixture()
    const evidence = evidenceFor(candidate)
    await assert.rejects(exportCandidate(directory, { bytes, candidate,
      evidence: { ...evidence, artifact: { ...evidence.artifact, sha256: 'a'.repeat(64) } }, manifest }), /evidence/)
    await assert.rejects(lstat(directory), { code: 'ENOENT' })
    await assert.rejects(exportCandidate(join(temporary, 'missing', 'candidate'), { bytes, candidate, evidence, manifest }))
    assert.deepEqual(await readdir(temporary), [])
    await mkdir(directory)
    await writeFile(join(directory, 'keep'), 'preserved')
    await assert.rejects(requireNewCandidateDirectory(directory), /already exist/)
    assert.equal(await readFile(join(directory, 'keep'), 'utf8'), 'preserved')
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('invalid import configuration fails before an acceptance report or candidate can be written', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'vivi-candidate-script-test-'))
  try {
    const report = join(temporary, 'report.json')
    const directory = join(temporary, 'candidate')
    const env = { ...process.env, VIVI_TEST_PACKAGE_ARCHIVE: join(temporary, filename),
      VIVI_TEST_CANDIDATE_DIR: directory, VIVI_TEST_ACCEPTANCE_REPORT: report }
    delete env.VIVI_TEST_PACKAGE_METADATA
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/test-package.mjs', import.meta.url))],
      { env, encoding: 'utf8', timeout: 10000 })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /supplied together/)
    assert.deepEqual(await readdir(temporary), [])
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('invalid candidate bytes or actual npm metadata fail before install and acceptance evidence', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'vivi-candidate-preinstall-test-'))
  try {
    const archive = join(temporary, filename)
    const metadata = join(temporary, 'candidate.json')
    const report = join(temporary, 'report.json')
    const calls = join(temporary, 'npm-calls.json')
    const fakeNpm = join(temporary, 'npm.cjs')
    await writeFile(archive, bytes)
    await writeFile(fakeNpm, `require('node:fs').writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)))\n` +
      `console.log(${JSON.stringify(JSON.stringify([packed]))})\n`)
    const env = { ...process.env, npm_execpath: fakeNpm, VIVI_TEST_PACKAGE_ARCHIVE: archive,
      VIVI_TEST_PACKAGE_METADATA: metadata, VIVI_TEST_ACCEPTANCE_REPORT: report }
    delete env.VIVI_TEST_CANDIDATE_DIR
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/test-package.mjs', import.meta.url))],
      { env, encoding: 'utf8', timeout: 10000 })
    const digestMismatch = fixture()
    digestMismatch.artifact.sha256 = 'a'.repeat(64)
    await writeFile(metadata, JSON.stringify(digestMismatch))
    const rejectedBytes = run()
    assert.notEqual(rejectedBytes.status, 0)
    assert.match(rejectedBytes.stderr, /SHA-256 mismatch/)
    await assert.rejects(lstat(calls), { code: 'ENOENT' })
    await assert.rejects(lstat(report), { code: 'ENOENT' })
    const metadataMismatch = fixture()
    metadataMismatch.npm.files[0].path = 'different.json'
    await writeFile(metadata, JSON.stringify(metadataMismatch))
    const rejectedMetadata = run()
    assert.notEqual(rejectedMetadata.status, 0)
    assert.match(rejectedMetadata.stderr, /does not match the actual npm archive/)
    const invocation = JSON.parse(await readFile(calls))
    assert.deepEqual(invocation.slice(0, 4), ['pack', '--dry-run', '--json', '--ignore-scripts'])
    assert.equal(invocation.length, 5)
    assert.notEqual(invocation[4], archive)
    assert(invocation[4].endsWith(filename))
    await assert.rejects(lstat(report), { code: 'ENOENT' })
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('CLI license comparison normalizes only CRLF and retains every other byte', () => {
  assert.deepEqual(normalizeLicense(Buffer.from('Legal\r\ntext\r\n')), Buffer.from('Legal\ntext\n'))
  assert.notDeepEqual(normalizeLicense(Buffer.from('Legal\rtext')), Buffer.from('Legal\ntext'))
  assert.notDeepEqual(normalizeLicense(Buffer.from('Changed\r\ntext')), Buffer.from('Legal\ntext'))
  assert.deepEqual(normalizeLicense(Buffer.from([0xff, 13, 10, 0xfe])), Buffer.from([0xff, 10, 0xfe]))
})
