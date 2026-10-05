// SPDX-License-Identifier: Apache-2.0
import { basename } from 'node:path'

/** Invoke npm's JS entrypoint rather than a .cmd shim with shell:false on Windows. */
export function npmInvocation(args, { npmPath = process.env.npm_execpath,
  node = process.execPath, platform = process.platform } = {}) {
  if (npmPath) return { command: node, args: [npmPath, ...args] }
  if (platform === 'win32') throw new Error('Run this check through npm run test:package on Windows')
  return { command: 'npm', args: [...args] }
}

/** Automated evidence is deliberately insufficient to claim platform or release acceptance. */
export function packageAcceptanceEvidence({ filename, sha256, integrity, size, cliVersion,
  platform = process.platform, arch = process.arch, node = process.version, bun }) {
  if (filename !== basename(filename) || !/^[a-z0-9][a-z0-9.-]*\.tgz$/.test(filename) ||
    !/^[a-f0-9]{64}$/.test(sha256) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity) ||
    !Number.isSafeInteger(size) || size < 1 || typeof cliVersion !== 'string' || !cliVersion ||
    !['win32', 'darwin', 'linux'].includes(platform) || typeof arch !== 'string' ||
    typeof node !== 'string' || (bun !== undefined && typeof bun !== 'string')) {
    throw new Error('Invalid package acceptance evidence')
  }
  return {
    schemaVersion: 1,
    kind: 'automated-headless-package-check',
    observed: { platform, arch, node, ...(bun === undefined ? {} : { bun }) },
    artifact: { filename, sha256, integrity, size, cliVersion },
    automated: {
      installedCliBin: 'passed', nodeLauncherWithoutTui: 'passed',
      installedHostWithoutTui: 'passed', fakeProviderRuntime: 'passed',
      installedTypeDeclarations: 'passed', bundledCoreBytesAndNotices: 'passed',
      dependencyCacheReinstall: 'passed',
      bunHeadlessRenderer: bun === undefined ? 'not-run' : 'passed'
    },
    manual: {
      cleanMachineInstallation: 'not-run', nativeVaultSaveLoad: 'not-run',
      nativeVaultLockedUnavailable: 'not-run', sessionOnlyRestart: 'not-run',
      interactiveBunStartup: 'not-run', interactiveCancellation: 'not-run',
      terminalRestoration: 'not-run', binaryReleaseLicenseReview: 'not-run'
    },
    platformAcceptance: 'pending-manual-validation',
    distributionDecision: 'not-recorded'
  }
}
