// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { CREDENTIAL_PROCESS_TIMEOUT_MS, MAX_API_KEY_LENGTH, MAX_CREDENTIAL_OUTPUT_BYTES,
  MAX_WINDOWS_CREDENTIAL_BYTES,
  NativeCredentialStore, createCredentialStore, runCredentialCommand, validateApiKey } from '../dist/credentials.js';

const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn);
const fakeKey = 'fake-api-key-for-tests-only';
const macEnvelope = (key) => `vivi-cli-api-key-v1:${Buffer.from(key).toString('base64')}`;
const result = (exitCode = 0, stdout = '', stderrPresent = false) => ({ exitCode, stdout, stderrPresent });
const environmentFingerprint = () => createHash('sha256').update(JSON.stringify(process.env)).digest('hex');

function fakeNative(platform) {
  const calls = [];
  const vault = new Map();
  const runner = async (command) => {
    calls.push(command);
    if (platform === 'darwin') {
      assert.equal(command.command, '/usr/bin/security');
      if (command.args[0] === 'default-keychain') return result();
      if (command.args[0] === '-i') {
        const match = /^add-generic-password -U -s vivi-cli -a (openai|openrouter) -X ([0-9a-f]+)\n$/.exec(command.stdin);
        assert.ok(match, 'one hex-only save command followed by EOF');
        vault.set(match[1], Buffer.from(match[2], 'hex').toString('utf8'));
        return result();
      }
      const key = vault.get(command.args[4]);
      if (key === undefined) return result(44, '', true);
      // Apple security -w prints bare hex if any byte is not printable, otherwise the bytes and LF.
      const bytes = Buffer.from(key);
      const output = bytes.some((byte) => byte < 0x20 || byte > 0x7e) ? bytes.toString('hex') : key;
      return result(0, `${output}\n`);
    }
    if (platform === 'win32') {
      assert.equal(win32.isAbsolute(command.command), true);
      assert.match(command.command, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
      assert.deepEqual(command.args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
      const [operation, provider] = command.stdin.split('\n');
      if (operation === 'status') { assert.equal(command.stdin, 'status\n'); return result(); }
      assert.ok(provider === 'openai' || provider === 'openrouter');
      const header = `${operation}\n${provider}\n`;
      if (operation === 'save') { vault.set(provider, command.stdin.slice(header.length)); return result(); }
      assert.equal(operation, 'load');
      assert.equal(command.stdin, header);
      return vault.has(provider) ? result(0, vault.get(provider)) : result(3);
    }
    assert.equal(command.command, 'secret-tool');
    if (command.args.includes('credential-probe')) return result(1);
    const provider = command.args.at(-1);
    if (command.args[0] === 'store') { vault.set(provider, command.stdin); return result(); }
    return vault.has(provider) ? result(0, vault.get(provider)) : result(1);
  };
  return { runner, calls, vault, store: new NativeCredentialStore({ platform, runner }) };
}

test('API key validation trims spaces, rejects controls and bounds input without echoing it', () => {
  assert.equal(validateApiKey(`  ${fakeKey}  `), fakeKey);
  assert.equal(validateApiKey('x'.repeat(MAX_API_KEY_LENGTH)), 'x'.repeat(MAX_API_KEY_LENGTH));
  assert.equal(validateApiKey('not-a-provider-specific-prefix'), 'not-a-provider-specific-prefix');
  assert.equal(validateApiKey('emoji-🔐-key'), 'emoji-🔐-key');
  for (const input of [undefined, null, 12, {}, '', '   ', 'x'.repeat(MAX_API_KEY_LENGTH + 1),
    ...['\n', '\r', '\t', '\0', '\x1b', '\x7f', '\x80', '\x9f', '\u2028', '\u2029',
      '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069']
      .map((control) => `${fakeKey}${control}`),
    `${fakeKey}\ud800`, `${fakeKey}\udfff`]) {
    assert.throws(() => validateApiKey(input), (error) => {
      assert.ok(!error.message.includes(fakeKey));
      assert.equal(error.cause, undefined);
      return /API key must/.test(error.message);
    });
  }
});

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform} saves both providers in native storage and loads them in a fresh store`, async () => {
    const { calls, runner, store } = fakeNative(platform);
    const env = environmentFingerprint();
    assert.deepEqual(await store.status(), { available: true,
      label: platform === 'darwin' ? 'macOS Keychain' : platform === 'linux' ? 'Linux Secret Service' : 'Windows Credential Manager' });
    assert.equal(await store.load('openai'), undefined);
    await store.save('openai', ` ${fakeKey} `);
    await store.save('openrouter', `${fakeKey}-router`);
    // Independent store instances simulate a later launch without a session/local-file cache.
    const nextLaunch = createCredentialStore({ platform, runner });
    assert.equal(await nextLaunch.load('openai'), fakeKey);
    assert.equal(await nextLaunch.load('openrouter'), `${fakeKey}-router`);
    await nextLaunch.save('openai', `${fakeKey}-replacement`);
    assert.equal(await store.load('openai'), `${fakeKey}-replacement`);
    assert.equal(environmentFingerprint(), env, 'native persistence never mutates process.env');
    for (const call of calls) {
      assert.ok(!JSON.stringify(call.args).includes(fakeKey));
      assert.ok(!JSON.stringify(call.args).includes(Buffer.from(fakeKey).toString('hex')));
      assert.ok(!JSON.stringify(call.args).includes(Buffer.from(fakeKey).toString('base64')));
      assert.ok(!call.args.includes('-A'), 'never enable unrestricted keychain access');
      assert.ok(!call.args.includes('-v'), 'never enable command diagnostics');
      if (call.stdin?.includes(fakeKey)) assert.equal(call.captureStdout, false);
    }
    const saves = calls.filter((call) => call.stdin && !call.captureStdout && call.stdin !== 'status\n');
    if (platform === 'linux') {
      assert.deepEqual(saves[0].args, ['store', '--label=Vivi CLI API key', 'application', 'vivi-cli', 'provider', 'openai']);
      assert.equal(saves[0].stdin, fakeKey, 'piped input has no added newline');
    } else if (platform === 'darwin') assert.deepEqual(saves[0].args, ['-i', '-q']);
    else {
      assert.equal(saves[0].stdin, `save\nopenai\n${fakeKey}`);
      assert.ok(calls.every((call) => JSON.stringify(call.args) === JSON.stringify(calls[0].args)),
        'Windows operation, provider and secret remain data in stdin; executable source is fixed');
    }
  });

  test(`${platform} never reports a successful save unless bounded read-back matches`, async () => {
    for (const readResult of [result(0, ''), result(0, 'other-fake-key'), result(1), result(null),
      result(0, fakeKey, true), result(0, `${fakeKey}\n\n`),
      result(0, platform === 'darwin' ? `${macEnvelope(` ${fakeKey} `)}\n` : ` ${fakeKey} `),
      result(0, fakeKey.repeat(MAX_CREDENTIAL_OUTPUT_BYTES))]) {
      const calls = [];
      const store = new NativeCredentialStore({ platform, runner: async (call) => {
        calls.push(call);
        return calls.length === 1 ? result() : readResult;
      } });
      await assert.rejects(store.save('openai', fakeKey), (error) => {
        assert.match(error.message, /Unable to save/);
        assert.ok(!error.message.includes(fakeKey));
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(calls.length, 2);
      assert.equal(calls[1].captureStdout, true);
    }
  });

  test(`${platform} returns generic failures for inaccessible, malformed or contaminated keyring results`, async () => {
    for (const behavior of [() => { throw new Error(`helper stderr ${fakeKey}`); },
      () => result(9, fakeKey, true), () => result(0, `${fakeKey}\x1b[31m`),
      () => result(0, 'x'.repeat(MAX_API_KEY_LENGTH + 1)), () => result(null),
      () => ({ exitCode: 0, stdout: {}, stderrPresent: false })]) {
      const store = new NativeCredentialStore({ platform, runner: async () => behavior() });
      assert.ok(!JSON.stringify(await store.status()).includes(fakeKey));
      await assert.rejects(store.load('openai'), (error) => {
        assert.match(error.message, /Unable to read/);
        assert.ok(!error.message.includes(fakeKey));
        assert.equal(error.cause, undefined);
        return true;
      });
      await assert.rejects(store.save('openrouter', fakeKey), (error) => {
        assert.match(error.message, /Unable to save/);
        assert.ok(!error.message.includes(fakeKey));
        return true;
      });
    }
  });

  test(`${platform} rejects invalid provider/key before invoking any helper`, async () => {
    const { store, calls } = fakeNative(platform);
    for (const provider of ['unsupported', '', 'openai\nquit', null]) {
      await assert.rejects(store.load(provider), /Unsupported credential provider/);
      await assert.rejects(store.save(provider, fakeKey), /Unsupported credential provider/);
    }
    await assert.rejects(store.save('openai', `${fakeKey}\n`), /API key must/);
    assert.equal(calls.length, 0);
  });
}

test('macOS stdin uses injection-proof hexadecimal and refuses line truncation before invoking the helper', async () => {
  const { store, calls } = fakeNative('darwin');
  const exoticKey = `fake'"\\; $(irrelevant) -key-🔐`;
  await store.save('openai', exoticKey);
  assert.ok(!calls[0].stdin.includes(exoticKey));
  assert.equal(await store.load('openai'), exoticKey);
  const callsBefore = calls.length;
  await assert.rejects(store.save('openai', 'x'.repeat(2048)), /macOS Keychain input limit/);
  assert.equal(calls.length, callsBefore);
});

test('macOS versioned encoding round-trips Unicode and hex-looking keys and refuses ambiguous native output', async () => {
  const { store, vault } = fakeNative('darwin');
  for (const key of ['abcdef0123456789', '界-🔐-fake-key']) {
    await store.save('openai', key);
    assert.equal(vault.get('openai'), macEnvelope(key));
    assert.equal(await store.load('openai'), key);
  }
  for (const raw of ['unversioned-fake-key', '0123abcd', 'vivi-cli-api-key-v1:',
    'vivi-cli-api-key-v1:Zm9v!!!', 'vivi-cli-api-key-v1:/w==', `${macEnvelope(fakeKey)}\n`]) {
    vault.set('openai', raw);
    await assert.rejects(store.load('openai'), /Unable to read/);
  }
});

test('Linux refuses libsecret stdin truncation before invoking the helper', async () => {
  const { store, calls } = fakeNative('linux');
  await assert.rejects(store.save('openai', '界'.repeat(3000)), /Linux Secret Service input limit/);
  assert.equal(calls.length, 0);
});

test('Windows stdin treats shell, JSON and Unicode characters solely as opaque key data', async () => {
  const { store, calls, vault } = fakeNative('win32');
  const exoticKey = 'fake\'"\\; $(irrelevant) ` -key-界-🔐-{"operation":"save"}';
  await store.save('openrouter', exoticKey);
  assert.equal(vault.get('openrouter'), exoticKey);
  assert.equal(await store.load('openrouter'), exoticKey);
  assert.equal(calls[0].stdin, `save\nopenrouter\n${exoticKey}`);
  assert.ok(!calls[0].args.join(' ').includes(exoticKey));
  assert.ok(!calls[0].args.join(' ').includes(Buffer.from(exoticKey).toString('base64')));
  assert.ok(calls.every((call) => JSON.stringify(call.args) === JSON.stringify(calls[0].args)));
});

test('Windows enforces the native blob byte limit before launching, including Unicode boundaries', async () => {
  assert.equal(MAX_WINDOWS_CREDENTIAL_BYTES, 5 * 512);
  const { store, calls } = fakeNative('win32');
  for (const key of ['x'.repeat(MAX_WINDOWS_CREDENTIAL_BYTES), '界'.repeat(853) + 'a', '🔐'.repeat(640)]) {
    assert.equal(Buffer.byteLength(key), MAX_WINDOWS_CREDENTIAL_BYTES);
    await store.save('openai', key);
    assert.equal(await store.load('openai'), key);
  }
  const callsBefore = calls.length;
  for (const key of ['x'.repeat(MAX_WINDOWS_CREDENTIAL_BYTES + 1), '界'.repeat(854), '🔐'.repeat(641)]) {
    await assert.rejects(store.save('openai', key), (error) => {
      assert.match(error.message, /Windows Credential Manager input limit.*session only/);
      assert.ok(!error.message.includes(key));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.equal(calls.length, callsBefore);
  const oversizedRead = new NativeCredentialStore({ platform: 'win32', runner: async () => result(0, '界'.repeat(854)) });
  await assert.rejects(oversizedRead.load('openai'), /Unable to read/);
});

test('Windows availability probe is read-only and uses bounded native persistence support', async () => {
  const { store, calls, vault } = fakeNative('win32');
  assert.deepEqual(await store.status(), { available: true, label: 'Windows Credential Manager' });
  assert.equal(vault.size, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stdin, 'status\n');
  assert.equal(calls[0].captureStdout, false);
  const script = calls[0].args.at(-1);
  assert.match(script, /CredGetSessionTypes\(\(uint\)persistence\.Length, persistence\)/);
  assert.match(script, /credential\.Persist = LocalMachine/);
  assert.match(script, /string target = "vivi-cli\/" \+ provider/);
  assert.match(script, /Console\.OpenStandardInput\(\)/);
  assert.match(script, /Console\.OpenStandardOutput\(\)/);
  assert.match(script, /new UTF8Encoding\(false, true\)/);
  assert.match(script, /Array\.Clear\(input, 0, input\.Length\)/);
  assert.match(script, /ClearNative\(blobPointer, length\)/);
  assert.match(script, /Marshal\.FreeHGlobal\(blobPointer\)/);
  assert.match(script, /CredFree\(pointer\)/);
  assert.match(script, /DefaultDllImportSearchPaths\(DllImportSearchPath\.System32\)/);
  assert.ok(!/ConvertFrom-Json|Invoke-Expression|Write-Output|Write-Error|Write-Host|Set-Content|Out-File|Start-Transcript/i.test(script));
  assert.ok(!calls[0].args.includes('-ExecutionPolicy'), 'never bypass the configured PowerShell execution policy');
  for (const probe of [result(1), result(2), result(3), result(0, '', true), result(null)]) {
    const unavailable = new NativeCredentialStore({ platform: 'win32', runner: async () => probe });
    assert.equal((await unavailable.status()).available, false);
  }
});

test('Windows only treats a clean native missing-item result as absent', async () => {
  const missing = new NativeCredentialStore({ platform: 'win32', runner: async () => result(3) });
  assert.equal(await missing.load('openai'), undefined);
  for (const readResult of [result(3, fakeKey), result(3, '', true), result(1), result(2), result(1168)]) {
    const store = new NativeCredentialStore({ platform: 'win32', runner: async () => readResult });
    await assert.rejects(store.load('openai'), /Unable to read/);
  }
});

test('missing helper and locked/absent service status are explicit and never fall back to a plaintext file', async () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const runner of [async () => { throw new Error(`ENOENT ${fakeKey}`); }, async () => result(1, '', true)]) {
      const store = new NativeCredentialStore({ platform, runner });
      const status = await store.status();
      assert.equal(status.available, false);
      assert.match(status.detail, /session only/);
      assert.ok(!JSON.stringify(status).includes(fakeKey));
    }
  }
});

test('other unsupported hosts use an explicit unavailable result without any process call', async () => {
  for (const platform of ['freebsd', 'aix']) {
    let calls = 0;
    const store = createCredentialStore({ platform, runner: async () => { calls++; throw new Error('must not run'); } });
    const status = await store.status();
    assert.equal(status.available, false);
    assert.match(status.detail, /not supported.*session only/);
    assert.equal(await store.load('openai'), undefined);
    await assert.rejects(store.save('openai', fakeKey), /not supported.*session only/);
    assert.equal(calls, 0);
  }
});

// Only harmless Node child programs run below. No test invokes an actual keychain, secret-tool or provider.
const nodeCommand = (code, extra = {}) => ({ command: process.execPath, args: ['-e', code], captureStdout: true, ...extra });

test('process runner sends fake input only via stdin and keeps helper stderr out of returned diagnostics', async () => {
  const output = await runCredentialCommand(nodeCommand(
    `let key = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => key += c); process.stdin.on('end', () => {
      process.stderr.write(key); process.stdout.write(JSON.stringify({ key, args: process.argv.slice(1) })); });`, { stdin: fakeKey }));
  assert.equal(output.exitCode, 0);
  assert.equal(output.stderrPresent, true);
  assert.deepEqual(JSON.parse(output.stdout), { key: fakeKey, args: [] });
  assert.deepEqual(Object.keys(output).sort(), ['exitCode', 'stderrPresent', 'stdout']);
  const discarded = await runCredentialCommand(nodeCommand('process.stdout.write("fake-discarded-key")', { captureStdout: false }));
  assert.equal(discarded.stdout, '');
});

test('process runner bounds total stdout/stderr even when stdout capture is disabled', async () => {
  for (const [stream, captureStdout] of [['stdout', true], ['stdout', false], ['stderr', false]]) {
    await assert.rejects(runCredentialCommand(nodeCommand(
      `process.${stream}.write('x'.repeat(1024))`, { maxOutputBytes: 100, captureStdout })), /output limit/);
  }
  await assert.rejects(runCredentialCommand(nodeCommand(
    "process.stdout.write('x'.repeat(60)); process.stderr.write('y'.repeat(60));", { maxOutputBytes: 100 })), /output limit/);
});

test('process runner times out and discards original spawn errors and invalid UTF-8', async () => {
  await assert.rejects(runCredentialCommand(nodeCommand('setInterval(() => {}, 1000)', { timeoutMs: 50 })), /timed out/);
  await assert.rejects(runCredentialCommand({ command: `/nonexistent/${fakeKey}`, args: [], captureStdout: false }), (error) => {
    assert.equal(error.message, 'OS credential helper could not start');
    assert.ok(!error.message.includes(fakeKey));
    assert.equal(error.cause, undefined);
    return true;
  });
  await assert.rejects(runCredentialCommand(nodeCommand('process.stdout.write(Buffer.from([0xff]))')), /invalid text/);
});

test('process limits cannot be disabled or enlarged', async () => {
  for (const extra of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: CREDENTIAL_PROCESS_TIMEOUT_MS + 1 },
    { maxOutputBytes: 0 }, { maxOutputBytes: MAX_CREDENTIAL_OUTPUT_BYTES + 1 }, { stdin: 'x'.repeat(32 * 1024 + 1) }]) {
    await assert.rejects(runCredentialCommand(nodeCommand('throw new Error("must not run")', extra)), /Invalid credential process limits/);
  }
});
