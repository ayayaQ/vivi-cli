// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expandMcpTemplate } from '../dist/mcp-templates.js'

// Scalar vectors independently transcribed from RFC 6570, with an absolute fixture prefix.
const values = { var: 'value', hello: 'Hello World!', path: '/foo/bar', x: '1024', y: '768', empty: '' }
for (const [expression, expected] of [
  ['{var}', 'value'], ['{hello}', 'Hello%20World%21'], ['{+hello}', 'Hello%20World!'],
  ['{+path}/here', '/foo/bar/here'], ['{#hello}', '#Hello%20World!'],
  ['{x,y}', '1024,768'], ['{+x,y}', '1024,768'], ['{#x,y}', '#1024,768'],
  ['{.x,y}', '.1024.768'], ['{/x,y}', '/1024/768'], ['{;x,y,empty}', ';x=1024;y=768;empty'],
  ['{?x,y,empty}', '?x=1024&y=768&empty='], ['?fixed=yes{&x,y,empty}', '?fixed=yes&x=1024&y=768&empty='],
  ['{var}/{var}', 'value/value'], ['{/empty}', '/'], ['{.empty}', '.'], ['{#empty}', '#'],
  ['{hello,x}', 'Hello%20World%21,1024']
]) test(`scalar RFC 6570 expansion ${expression}`, () => {
  const names = [...new Set(expression.match(/[A-Za-z]+/g).filter(name => Object.hasOwn(values, name)))]
  assert.equal(expandMcpTemplate(`fixture:${expression}`, Object.fromEntries(names.map(name => [name, values[name]]))), `fixture:${expected}`)
})
test('template expansion preserves exact percent bytes, Unicode, punctuation and generic URI identity', () => {
  assert.equal(expandMcpTemplate('fixture:{value}', { value: "%2f %FF !'()* 😀" }), 'fixture:%252f%20%25FF%20%21%27%28%29%2A%20%F0%9F%98%80')
  assert.equal(expandMcpTemplate('fixture:{+value}', { value: '%2f/%FF/invalid%/😀' }), 'fixture:%2f/%FF/invalid%25/%F0%9F%98%80')
  assert.equal(expandMcpTemplate('FIXTURE://Mixed.Host:0042/a/../{name}?raw=%2f', { name: 'x/y' }), 'FIXTURE://Mixed.Host:0042/a/../x%2Fy?raw=%2f')
  assert.equal(expandMcpTemplate('urn:fixture:{value}', { value: 'hello' }), 'urn:fixture:hello')
  assert.equal(expandMcpTemplate('fixture:///{constructor}', { constructor: 'ordinary' }), 'fixture:///ordinary')
})
test('unsupported templates and nonexact scalar values fail closed', () => {
  for (const template of ['relative/{x}', 'fixture:{x*}', 'fixture:{x:2}', 'fixture:{%78}', 'fixture:{=x}', 'fixture:{x', 'fixture:constant', 'fixture:{x}{']) {
    assert.throws(() => expandMcpTemplate(template, { x: 'ordinary' }))
  }
  for (const variables of [{}, { x: 'ordinary', extra: 'x' }, { x: ['x'] }, { x: {} }, { x: 7 }, { x: null }, { x: 'line\nbreak' }, { x: '\ud800' }, { x: 'x'.repeat(4097) }, { x: '😀'.repeat(1025) }]) {
    assert.throws(() => expandMcpTemplate('fixture:{x}', variables))
  }
  assert.throws(() => expandMcpTemplate('fixture:{x}/{x}', { x: 'x'.repeat(3000) }))
  assert.throws(() => expandMcpTemplate('fixture://{+host}/x', { host: '[' }))
})

test('malformed reserved percent escapes are withheld by the shared URI gate', () => {
  for (const operator of ['+', '#']) for (const value of ['%A', '%2', 'space %A']) {
    assert.throws(() => expandMcpTemplate(`fixture:{${operator}value}`, { value }))
  }
})
