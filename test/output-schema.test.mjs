// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateContext } from '@ayayaq/vivi';
import { OutputSchema, OutputSchemaError, OUTPUT_SCHEMA_LIMITS, OUTPUT_SCHEMA_DIALECT, loadOutputSchema } from '../dist/output-schema.js';
const matches = (code, phase = 'configuration') => error => {
  assert(error instanceof OutputSchemaError);
  assert.equal(error.code, code);
  assert.equal(error.phase, phase);
  assert(!error.message.includes('sensitive'));
  return true;
};
const objectSchema = { type: 'object', properties: { status: { enum: ['ok', 'action_required'] }, summary: { type: 'string', minLength: 1 } }, required: ['status', 'summary'], additionalProperties: false };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-output-schema-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

test('output schema validates structural data without coercion, defaults, removal or extra fields', () => {
  const schema = new OutputSchema(objectSchema);
  assert.deepEqual(schema.validate('{"status":"ok","summary":"Done"}', []), { status: 'ok', summary: 'Done' });
  for (const value of ['{"status":"unknown","summary":"Done"}', '{"status":"ok","summary":""}', '{"status":"ok","summary":"Done","extra":true}', '{"status":"ok"}']) {
    assert.throws(() => schema.validate(value, []), matches('schema_mismatch', 'output'));
  }
  const defaults = new OutputSchema({ type: 'object', properties: { count: { type: 'integer', default: 3 } } });
  assert.deepEqual(defaults.validate('{}', []), {});
  assert.throws(() => defaults.validate('{"count":"3"}', []), matches('schema_mismatch', 'output'));
});

test('output schema supports boolean schemas, scalar JSON, arrays, tuples and combinators', () => {
  assert.equal(new OutputSchema(true).validate('null', []), null);
  assert.throws(() => new OutputSchema(false).validate('null', []), matches('schema_mismatch', 'output'));
  assert.equal(new OutputSchema({ type: ['string', 'null'] }).validate('"fine"', []), 'fine');
  const array = new OutputSchema({ type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'integer', minimum: 2, maximum: 8, multipleOf: 2 }, minItems: 2, maxItems: 3 });
  assert.deepEqual(array.validate('["x",2,8]', []), ['x', 2, 8]);
  assert.throws(() => array.validate('["x",3]', []), matches('schema_mismatch', 'output'));
  const combination = new OutputSchema({ allOf: [{ anyOf: [{ const: 2 }, { const: 4 }] }, { not: { const: 4 } }] });
  assert.equal(combination.validate('2', []), 2);
  assert.throws(() => combination.validate('4', []), matches('schema_mismatch', 'output'));
});

test('output schema supports bounded local acyclic refs including escaped pointer keys', () => {
  const schema = new OutputSchema({ $schema: OUTPUT_SCHEMA_DIALECT, $defs: { 'a/b~c': { type: 'integer', exclusiveMinimum: 1, exclusiveMaximum: 5 } }, $ref: '#/$defs/a~1b~0c' });
  assert.equal(schema.validate('3', []), 3);
  assert.throws(() => schema.validate('5', []), matches('schema_mismatch', 'output'));
  assert.equal(new OutputSchema({ $defs: { 'sp ace': { const: true } }, $ref: '#/$defs/sp%20ace' }).validate('true', []), true);
});

test('output schema rejects unknown constraints, dialects, identifiers and nonlocal refs without loading', () => {
  for (const keyword of ['pattern', 'patternProperties', 'format', 'unevaluatedProperties', '$id', '$dynamicRef', '$async', 'madeUpConstraint']) {
    assert.throws(() => new OutputSchema({ [keyword]: 'sensitive' }), matches('output_schema_unsupported'));
  }
  for (const $ref of ['https://example.com/sensitive.json', 'file:///sensitive.json', 'relative.json', '#anchor']) {
    assert.throws(() => new OutputSchema({ $ref }), matches('output_schema_unsupported'));
  }
  assert.throws(() => new OutputSchema({ $schema: 'http://json-schema.org/draft-07/schema#' }), matches('output_schema_unsupported'));
  assert.throws(() => new OutputSchema({ type: 'unrecognized' }), matches('output_schema_invalid'));
  assert.throws(() => new OutputSchema({ type: 'integer', minimum: 'secret value' }), matches('output_schema_invalid'));
});

test('output schema refs cannot reach missing locations, annotation data or malformed pointers', () => {
  for (const schema of [{ $ref: '#/$defs/missing' }, { const: { type: 'integer' }, $ref: '#/const' }, { $ref: '#/~2bad' }, { $ref: '#/%GG' }]) {
    assert.throws(() => new OutputSchema(schema), matches('output_schema_invalid'));
  }
});

test('output schema bounds cycles, expanded DAG visits, reference hops and branch counts before compile', () => {
  assert.throws(() => new OutputSchema({ $ref: '#' }), matches('output_schema_too_complex'));
  assert.throws(() => new OutputSchema({ $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } } }), matches('output_schema_too_complex'));
  const $defs = { end: { type: 'string' } };
  for (let i = 17; i >= 0; i--) $defs['n' + i] = { $ref: i === 17 ? '#/$defs/end' : '#/$defs/n' + (i + 1) };
  assert.throws(() => new OutputSchema({ $defs, $ref: '#/$defs/n0' }), matches('output_schema_too_complex'));
  const dag = { leaf: { type: 'string' } };
  for (let i = 0; i < 4; i++) dag['n' + i] = { anyOf: Array.from({ length: 8 }, () => ({ $ref: i === 0 ? '#/$defs/leaf' : '#/$defs/n' + (i - 1) })) };
  assert.throws(() => new OutputSchema({ $defs: dag, $ref: '#/$defs/n3' }), matches('output_schema_too_complex'));
  assert.throws(() => new OutputSchema({ anyOf: Array(17).fill(true) }), matches('output_schema_too_complex'));
  assert.throws(() => new OutputSchema({ properties: Object.fromEntries(Array.from({ length: 256 }, (_, i) => ['p' + i, true])) }), matches('output_schema_too_complex'));
  let nested = true;
  for (let i = 0; i < 33; i++) nested = { not: nested };
  assert.throws(() => new OutputSchema(nested), matches('output_schema_too_complex'));
});

test('output schema rejects invalid, too-large, nonfinite and deeply nested final JSON without raw values', () => {
  const schema = new OutputSchema(true);
  for (const value of ['```json\n{}\n```', 'prefix {}', '{', '{} {}', 'undefined', '1e999']) {
    assert.throws(() => schema.validate(value, []), matches('invalid_json', 'output'));
  }
  assert.throws(() => schema.validate(JSON.stringify('x'.repeat(OUTPUT_SCHEMA_LIMITS.outputBytes)), []), matches('output_too_large', 'output'));
  assert.throws(() => schema.validate('['.repeat(129) + '0' + ']'.repeat(129), []), matches('invalid_json', 'output'));
});

test('output schema refuses secrets in raw or escaped decoded final values and property names', () => {
  const schema = new OutputSchema(true);
  for (const content of ['"sensitive"', '{"sensitive":true}', '"sens\\u0069tive"', '{"sens\\u0069tive":0}', '{"nested":["sensitive"]}']) {
    assert.throws(() => schema.validate(content, ['sensitive']), matches('output_redacted', 'output'));
  }
  assert.deepEqual(schema.validate('{"safe":"not a credential"}', ['sensitive']), { safe: 'not a credential' });
});

test('output schema rejects initial schema secrets and rechecks dynamic credentials before estimate and every generate', async () => {
  assert.throws(() => new OutputSchema({ const: 'sensitive' }, ['sensitive']), matches('output_schema_redacted'));
  assert.throws(() => new OutputSchema({ properties: { sensitive: true } }, ['sensitive']), matches('output_schema_redacted'));
  const schema = new OutputSchema({ description: 'Later credential: sensitive', type: 'string' });
  const secrets = []; let calls = 0;
  const provider = schema.wrapProvider({ estimateContext: () => { calls++; return { inputTokens: 1, estimated: true }; }, generate: async () => { calls++; return { content: '"ok"', toolCalls: [] }; } }, () => secrets);
  const input = { messages: [], tools: [] };
  assert.equal(provider.estimateContext(input).inputTokens, 1);
  secrets.push('sensitive');
  assert.throws(() => provider.estimateContext(input), matches('output_schema_redacted'));
  assert.throws(() => provider.generate(input, new AbortController().signal), matches('output_schema_redacted'));
  assert.throws(() => provider.generate(input, new AbortController().signal, { purpose: 'context-summary' }), matches('output_schema_redacted'));
  assert.equal(calls, 1);
});

test('output schema wrapper preserves inputs, signals/options, provider this and bounds; summary receives no schema', async () => {
  const schema = new OutputSchema(objectSchema); const seen = [];
  const provider = { defaultOutputTokens: 123,
    estimateContext(input, options) { assert.equal(this, provider); seen.push({ kind: 'estimate', input, options }); return { inputTokens: 99, estimated: true }; },
    async generate(input, signal, options) { assert.equal(this, provider); seen.push({ kind: 'generate', input, signal, options }); return { content: '{}', toolCalls: [] }; }
  };
  const wrapped = schema.wrapProvider(provider, () => []);
  const input = { messages: [{ kind: 'message', role: 'user', content: 'Original' }], tools: [] };
  const original = structuredClone(input), signal = new AbortController().signal, options = { maxOutputTokens: 11, purpose: 'response' };
  assert.equal(wrapped.defaultOutputTokens, 123);
  assert.deepEqual(wrapped.estimateContext(input, { maxOutputTokens: 11 }), { inputTokens: 99, estimated: true });
  await wrapped.generate(input, signal, options);
  await wrapped.generate(input, signal, { purpose: 'context-summary' });
  assert.deepEqual(input, original);
  assert.equal(seen[0].input.messages.length, 2);
  assert.equal(seen[1].input.messages[0].role, 'system');
  assert(seen[1].input.messages[0].content.includes(JSON.stringify(objectSchema)));
  assert.equal(seen[1].signal, signal); assert.equal(seen[1].options, options);
  assert.equal(seen[2].input, input);
  assert.equal(typeof schema.wrapProvider({ generate: async () => ({ content: '{}', toolCalls: [] }) }, () => []).estimateContext, 'function');
});

test('output schema descriptor loader handles regular files and refuses missing, directories, malformed UTF8 and bounds', async t => {
  const directory = await fixture(t), file = join(directory, 'schema.json');
  await writeFile(file, JSON.stringify(objectSchema));
  assert.deepEqual((await loadOutputSchema(file)).validate('{"status":"ok","summary":"Done"}', []), { status: 'ok', summary: 'Done' });
  await assert.rejects(loadOutputSchema(join(directory, 'sensitive-missing')), matches('output_schema_unreadable'));
  await assert.rejects(loadOutputSchema(directory), matches('output_schema_unreadable'));
  for (const value of ['{', 'null', '[]', '1e999', Buffer.from([0xc3, 0x28])]) {
    await writeFile(file, value);
    await assert.rejects(loadOutputSchema(file), error => error instanceof OutputSchemaError && error.phase === 'configuration');
  }
  await writeFile(file, ' '.repeat(OUTPUT_SCHEMA_LIMITS.bytes + 1));
  await assert.rejects(loadOutputSchema(file), matches('output_schema_too_large'));
  await writeFile(file, '{"const":"sens\\u0069tive"}');
  await assert.rejects(loadOutputSchema(file, ['sensitive']), matches('output_schema_redacted'));
});


test('output schema accepts bounded wide JSON arrays without argument-spread overflow', () => {
  const content = '[' + Array(100_000).fill('0').join(',') + ']';
  assert.equal(new OutputSchema(true).validate(content, []).length, 100_000);
});


test('output schema fallback estimate includes its exact ephemeral prefix and rechecks dynamic secrets', async () => {
  const secrets = [], schema = new OutputSchema({ type: 'string', description: 'sensitive' });
  let received;
  const wrapped = schema.wrapProvider({ generate: async input => { received = input; return { content: '\"ok\"', toolCalls: [] }; } }, () => secrets);
  const input = { messages: [{ kind: 'message', role: 'user', content: 'Original' }], tools: [] };
  const measured = wrapped.estimateContext(input);
  await wrapped.generate(input, new AbortController().signal);
  assert.deepEqual(measured, estimateContext(received));
  assert(measured.inputTokens > estimateContext(input).inputTokens);
  secrets.push('sensitive');
  assert.throws(() => wrapped.estimateContext(input), matches('output_schema_redacted'));
});
