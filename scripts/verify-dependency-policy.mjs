// SPDX-License-Identifier: Apache-2.0
// Loopback-only integration test of the installed manager, not a lockfile audit.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { npmCommand, supportsPolicy } from './dependency-toolchain.mjs'

const manager = process.argv[2]
assert(['npm', 'bun'].includes(manager), 'Usage: node scripts/verify-dependency-policy.mjs npm|bun')
const project = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', project), 'utf8'))
const isCli = manifest.name === '@ayayaq/vivi-cli'
assert(isCli || manifest.name === '@ayayaq/vivi', 'Unknown policy owner')
const npmConfig = (await readFile(new URL('.npmrc', project), 'utf8')).replaceAll('\r\n', '\n')
const bunConfig = (await readFile(new URL('bunfig.toml', project), 'utf8')).replaceAll('\r\n', '\n')
assert.match(npmConfig, /^min-release-age=7$/m)
assert.match(bunConfig, /^minimumReleaseAge = 604800$/m)
assert.deepEqual(npmConfig.split('\n').filter(line => line.startsWith('min-release-age-exclude')),
  isCli ? ['min-release-age-exclude[]=@ayayaq/vivi'] : [])
assert.deepEqual(bunConfig.split('\n').filter(line => line.startsWith('minimumReleaseAgeExcludes')),
  isCli ? ['minimumReleaseAgeExcludes = ["@ayayaq/vivi"]'] : [])
assert.deepEqual(manifest.devEngines.packageManager, { name: 'npm', version: '>=11.17.0', onFail: 'error' })

const [command, prefix] = manager === 'npm' ? npmCommand() : ['bun', []]
const temporary = await mkdtemp(join(tmpdir(), 'vivi-dependency-policy-'))
const userConfig = join(temporary, 'user.npmrc')
const globalConfig = join(temporary, 'global.npmrc')
await writeFile(userConfig, '')
await writeFile(globalConfig, '')
// No inherited credentials, global npm config, proxy config or user Bun config.
const environment = {
  PATH: process.env.PATH ?? process.env.Path, HOME: temporary, USERPROFILE: temporary,
  TEMP: temporary, TMP: temporary, TMPDIR: temporary,
  npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {})
}
let invocation = 0
async function execute(directory, args) {
  const cache = join(temporary, `cache-${invocation++}`)
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], { cwd: directory, shell: false,
      env: { ...environment, npm_config_cache: cache, BUN_INSTALL_CACHE_DIR: cache } })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const timer = setTimeout(() => child.kill(), 30_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }) })
  })
}

// A tiny valid gzip/tar package, constructed without host tar or dependencies.
function tarball(name) {
  const contents = Buffer.from(JSON.stringify({ name, version: '1.0.0' }))
  const header = Buffer.alloc(512)
  const put = (text, offset) => header.write(text, offset, 'ascii')
  put('package/package.json', 0)
  put('0000644\0', 100); put('0000000\0', 108); put('0000000\0', 116)
  put(contents.length.toString(8).padStart(11, '0') + '\0', 124)
  put('00000000000\0', 136); header.fill(' ', 148, 156)
  put('0', 156); put('ustar\0', 257); put('00', 263)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  put(checksum.toString(8).padStart(6, '0') + '\0 ', 148)
  return gzipSync(Buffer.concat([header, contents, Buffer.alloc((512 - contents.length % 512) % 512 + 1024)]))
}
let base
let lockedIsFresh = false
let freshTransitive = false
const names = new Set(['aged-fixture', 'new-fixture', 'locked-fixture', '@ayayaq/vivi', '@ayayaq/other'])
const server = createServer((request, response) => {
  const url = new URL(request.url, base)
  const name = decodeURIComponent(url.pathname.slice(1))
  if (!names.has(name)) { response.writeHead(404).end(); return }
  if (url.searchParams.has('tar')) { response.end(tarball(name)); return }
  const aged = name === 'aged-fixture' || (name === 'locked-fixture' && !lockedIsFresh)
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ name, 'dist-tags': { latest: '1.0.0' },
    time: { '1.0.0': new Date(Date.now() - (aged ? 30 * 86400_000 : 3600_000)).toISOString() },
    versions: { '1.0.0': { name, version: '1.0.0',
      dependencies: name === '@ayayaq/vivi' && freshTransitive ? { 'new-fixture': '1.0.0' } : {},
      dist: { tarball: `${base}/${encodeURIComponent(name)}?tar=1` } } } }))
})
try {
  const version = await execute(temporary, ['--version'])
  assert.equal(version.code, 0, version.output)
  assert(supportsPolicy(manager, version.output.trim()),
    `Unsupported ${manager} ${version.output.trim()}; requires npm >=11.17.0 or Bun >=1.4.2`)
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${server.address().port}`
  const setup = async (label, dependency) => {
    const directory = join(temporary, label)
    await mkdir(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'policy-fixture',
      version: '1.0.0', private: true, devEngines: manifest.devEngines, dependencies: { [dependency]: '1.0.0' } }))
    await writeFile(join(directory, '.npmrc'), `${npmConfig}\nregistry=${base}\n@ayayaq:registry=${base}\n`)
    await writeFile(join(directory, 'bunfig.toml'), `${bunConfig}\nregistry = "${base}"\n`)
    return directory
  }
  const resolutionArgs = ['install', manager === 'npm' ? '--package-lock-only' : '--lockfile-only',
    '--ignore-scripts', '--no-audit', ...(manager === 'npm' ? ['--no-fund'] : [])]
  const verify = async (label, dependency, accepted) => {
    const result = await execute(await setup(label, dependency), resolutionArgs)
    if (accepted) assert.equal(result.code, 0, `${label}: ${result.output}`)
    else {
      assert.notEqual(result.code, 0, `${label}: fresh release unexpectedly accepted`)
      assert.match(result.output, manager === 'npm' ? /ETARGET[\s\S]*date before/ : /blocked by minimum-release-age/,
        `${label}: not an age-policy rejection: ${result.output}`)
    }
    console.log(`PASS ${label}`)
  }
  await verify('old-third-party-allowed', 'aged-fixture', true)
  await verify('fresh-third-party-blocked', 'new-fixture', false)
  await verify(isCli ? 'fresh-core-exempt' : 'core-no-unneeded-exemption', '@ayayaq/vivi', isCli)
  await verify('scope-neighbor-not-exempt', '@ayayaq/other', false)
  if (isCli) {
    freshTransitive = true
    await verify('trusted-core-third-party-still-blocked', '@ayayaq/vivi', false)
    freshTransitive = false
  }
  const locked = await setup('existing-lock', 'locked-fixture')
  const seed = await execute(locked, resolutionArgs)
  assert.equal(seed.code, 0, seed.output)
  lockedIsFresh = true
  const install = await execute(locked, manager === 'npm'
    ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund'] : ['install', '--frozen-lockfile', '--ignore-scripts'])
  assert.equal(install.code, 0, `Locked-install behavior changed; reassess documentation: ${install.output}`)
  console.log(`PASS existing lock is NOT age-audited by ${manager}; new resolution tests passed (${version.output.trim()})`)
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve))
  await rm(temporary, { recursive: true, force: true })
}
