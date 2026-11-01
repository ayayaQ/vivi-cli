// SPDX-License-Identifier: Apache-2.0
import { basename } from 'node:path'

// This contract contains identifiers and outcomes only. Never add free-form logs,
// account metadata, native output, paths, OAuth responses or credential values.
export const syntheticChecks = Object.freeze([
  'providerSlots', 'scopedWrappingKeys', 'helperUnavailable',
  'absentPreflight', 'occupiedPreflight', 'uncertainPreflight',
  'chatgptEnvelope', 'chatgptRestart', 'chatgptDomainSeparation',
  'chatgptTamperRejected', 'chatgptLocked', 'chatgptSessionOnly'
])

export const manualStageChecks = Object.freeze(Object.fromEntries(Object.entries({
  nativePreflight: ['metadataOnly', 'allTargetsAbsent'],
  nativeSaveLoad: ['writeAuthorized', 'absenceRechecked', 'fakeRoundTrip'],
  nativeRestart: ['sameArtifact', 'fakeRoundTrip'],
  nativeUnavailable: ['actualUnavailableSession', 'safeFailure'],
  nativeSessionOnly: ['noNativeSave', 'absentAfterRestart'],
  chatgptRegistration: ['explicitSignIn', 'issuedClientBound'],
  chatgptBrowserReturn: ['verifiedReturn', 'identityBound'],
  chatgptCancellation: ['cancelled', 'noLateSignIn'],
  chatgptAccountWorkspace: ['distinctRegistrations', 'selectionBound'],
  chatgptEntitlement: ['signedIn', 'planUsageChecked', 'noApiKeyFallback'],
  chatgptRestart: ['sameArtifact', 'savedSignInRestored'],
  chatgptLogout: ['selectedAccountSignedOut', 'otherAccountsPreserved'],
  chatgptRevocation: ['revocationAuthorized', 'remoteRevocationConfirmed'],
  chatgptSessionOnly: ['explicitSessionOnly', 'noNativeSave', 'signedOutAfterRestart'],
  chatgptInference: ['inferenceAuthorized', 'selectedPlanAccount', 'requestSucceeded', 'noApiKeyFallback'],
  terminalStartup: ['actualTerminal', 'nativeBunStartup'],
  terminalRestoration: ['normalExit', 'idleCtrlC', 'cursorEchoRawModeRestored'],
  windowsPhysicalKeys: ['physicalEnter', 'physicalShiftEnter', 'physicalCtrlJ', 'diagnosticReviewed']
}).map(([name, checks]) => [name, Object.freeze(checks)])))

const invalid = () => { throw new Error('Invalid acceptance evidence') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function exact(value, keys) {
  if (!record(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) invalid()
}
function denseStrings(value) {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index) || typeof value[index] !== 'string' || value[index].length === 0) return false
  }
  return true
}
function utc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid()
}
function validateBinding(binding) {
  exact(binding, ['candidateSha', 'artifactSha256', 'artifactKind', 'platform', 'arch', 'node'])
  const { candidateSha, artifactSha256, artifactKind, platform, arch, node } = binding
  if (typeof candidateSha !== 'string' || !/^[a-f0-9]{40}$/.test(candidateSha) ||
    typeof artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifactSha256) ||
    !['synthetic-fixture', 'canonical-package'].includes(artifactKind) ||
    !['win32', 'darwin', 'linux'].includes(platform) ||
    !['x64', 'arm64'].includes(arch) || !supportsCliNode(node)) invalid()
  return { candidateSha, artifactSha256, artifactKind, platform, arch, node }
}

/** A presence probe accepts metadata, never a credential store or its load method.
 * Absence permits planning only: it does not authorize writes or eliminate races. */
export async function targetPreflight(targets, metadata) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 40 || !denseStrings(targets) ||
    new Set(targets).size !== targets.length ||
    targets.some(target => !/^(openai|openrouter|deepseek|deepseek-web|mcp-oauth-key-v1-[a-f0-9]{64})$/.test(target))) invalid()
  try {
    if (await metadata.available() !== true) return { status: 'blocked', reason: 'helper_unavailable' }
    const states = []
    for (const target of targets) {
      const presence = await metadata.presence(target)
      if (!['absent', 'occupied', 'uncertain'].includes(presence)) return { status: 'blocked', reason: 'uncertain' }
      states.push(presence)
    }
    if (states.includes('occupied')) return { status: 'blocked', reason: 'occupied' }
    if (states.includes('uncertain')) return { status: 'blocked', reason: 'uncertain' }
    return { status: 'eligible', reason: 'all_absent' }
  } catch { return { status: 'blocked', reason: 'uncertain' } }
}

/** Synthetic checks cannot promote any live/manual stage to passed. */
export function syntheticAcceptanceEvidence(input) {
  exact(input, ['binding', 'generatedAt', 'checks'])
  const binding = validateBinding(input.binding); utc(input.generatedAt)
  exact(input.checks, syntheticChecks)
  if (syntheticChecks.some(check => typeof input.checks[check] !== 'boolean')) invalid()
  return {
    schemaVersion: 2, kind: 'synthetic-platform-acceptance',
    generatedAt: input.generatedAt, binding,
    stage: 'synthetic-helper-store-report',
    checks: Object.fromEntries(syntheticChecks.map(check => [check, input.checks[check] ? 'passed' : 'failed'])),
    syntheticResult: syntheticChecks.every(check => input.checks[check]) ? 'passed' : 'failed',
    credentialModel: {
      providerSlots: ['openai', 'openrouter', 'deepseek', 'deepseek-web'],
      nativeWrappingSlot: 'mcp-oauth-key-v1-{sha256}',
      chatgpt: { envelopeFields: ['version', 'iv', 'tag', 'ciphertext'], version: 1,
        cipher: 'aes-256-gcm', keyBytes: 32, ivBytes: 12, tagBytes: 16,
        scope: 'sha256(vivi-cli/chatgpt-auth/v1\\0 + canonical-directory)',
        aad: 'vivi-cli/chatgpt-auth/v1/{hostId}/{accountId}',
        metadata: ['host.json', 'registrations.json'], records: 'account-{sha256}.json' }
    },
    manual: Object.fromEntries(Object.keys(manualStageChecks).map(stage => [stage, { status: 'not_run' }])),
    authSuccessIsInferenceSuccess: false, apiKeyBillingFallback: false,
    platformAcceptance: 'pending_manual_validation'
  }
}

/** Records a human assertion, not a live executor. Receipts must be sanitized and
 * bound to canonical bytes. Synthetic-fixture receipts cannot become live passes. */
export function manualStageEvidence(binding, stage, evidence) {
  const expectedBinding = validateBinding(binding)
  if (!Object.hasOwn(manualStageChecks, stage)) invalid()
  if (evidence?.status === 'not_run') { exact(evidence, ['status']); return { status: 'not_run' } }
  if (evidence?.status === 'blocked') {
    exact(evidence, ['status', 'reason'])
    if (!['not_authorized', 'helper_unavailable', 'occupied', 'uncertain', 'interactive_required', 'unsupported_platform'].includes(evidence.reason)) invalid()
    return { ...evidence }
  }
  exact(evidence, ['status', 'receipt'])
  if (!['passed', 'failed'].includes(evidence.status) || expectedBinding.artifactKind !== 'canonical-package') invalid()
  const receipt = evidence.receipt
  exact(receipt, ['binding', 'stage', 'completedAt', 'checks', 'receiptSha256'])
  const { stage: receiptStage, completedAt, checks, receiptSha256 } = receipt
  const receiptBinding = validateBinding(receipt.binding); utc(completedAt)
  const requiredChecks = manualStageChecks[stage]
  if (Object.keys(expectedBinding).some(key => expectedBinding[key] !== receiptBinding[key]) || receiptStage !== stage ||
    typeof receiptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receiptSha256) || !Array.isArray(checks) ||
    checks.length > requiredChecks.length || !denseStrings(checks) || new Set(checks).size !== checks.length ||
    checks.some(check => !requiredChecks.includes(check)) ||
    evidence.status === 'passed' && !requiredChecks.every(check => checks.includes(check)) ||
    stage === 'windowsPhysicalKeys' && expectedBinding.platform !== 'win32') invalid()
  return { status: evidence.status,
    receipt: { binding: receiptBinding, stage: receiptStage, completedAt, checks: [...checks], receiptSha256 } }
}

export function supportsCliNode(version) {
  const match = typeof version === 'string' && /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  return [major, minor, patch].every(Number.isSafeInteger) && (major > 26 || major === 26 && minor >= 4)
}

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
    !supportsCliNode(node) || (bun !== undefined && typeof bun !== 'string')) {
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
      dependencyCacheReinstall: 'passed', strictNpmEngines: 'passed',
      bunHeadlessRenderer: bun === undefined ? 'not-run' : 'passed'
    },
    manual: {
      cleanMachineInstallation: 'not-run', nativeVaultSaveLoad: 'not-run',
      nativeVaultLockedUnavailable: 'not-run', sessionOnlyRestart: 'not-run',
      interactiveBunStartup: 'not-run', interactiveCancellation: 'not-run',
      terminalRestoration: 'not-run', binaryReleaseLicenseReview: 'not-run'
    },
    platformAcceptance: 'pending-manual-validation',
    releaseTarget: { platform: 'win32', arch: 'x64', distribution: 'npm', node: '>=26.4.0', bun: '>=1.3.0' },
    distributionDecision: 'windows-npm-selected'
  }
}
