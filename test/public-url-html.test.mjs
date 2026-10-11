// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { decodePublicUrlHtmlEntities, extractPublicUrlHtml, PUBLIC_URL_HTML_EXTRACTION_VERSION } from '../dist/public-url-html.js'

const extract = value => extractPublicUrlHtml(value, () => {})
const maxSourceBytes = 1024 * 1024

test('HTML extraction identifies its named-entity subset and uses only inert built-ins', async () => {
  assert.match(PUBLIC_URL_HTML_EXTRACTION_VERSION, /subset/)
  const source = await readFile(new URL('../src/public-url-html.ts', import.meta.url), 'utf8')
  assert(!/\b(?:fetch|eval|Function|XMLHttpRequest|DOMParser|require)\s*\(/.test(source))
  assert(!/^import .* from /m.test(source))
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('Unexpected network access') }
  try {
    assert.equal(await extract('<a href="https://invalid.example/">Link</a><img src="https://invalid.example/p.png"><script src="https://invalid.example/s.js">throw Error("execution")</script>'), 'Link')
  } finally { globalThis.fetch = originalFetch }
})

test('normalizes text whitespace and useful block, line, and table boundaries', async () => {
  assert.equal(await extract(' \n <h1> Title </h1><p> First\t paragraph </p><p>Second<br>line</p><table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table> '), 'Title\nFirst paragraph\nSecond\nline\nA B\nC')
  assert.equal(await extract('<span>a</span><span>b</span>'), 'ab')
})

test('discards script, style, noscript, comments, and nested template content', async () => {
  const html = '<p>one</p><!-- <p>hidden</p> --><SCRIPT type="text/javascript">if (x < 2) { "<template>"; }</script><style>.hidden { content: ">"; }</style><noscript><p>hidden</p></noscript><template>outer<template>inner</template>tail<script>"</template>"</script></template><p>two</p>'
  assert.equal(await extract(html), 'one\ntwo')
  assert.equal(await extract('before<template/>hidden<template>nested</template></template>after'), 'before after')
  assert.equal(await extract('before<script/>hidden</script>after'), 'before\nafter')
})

test('suppresses browser double-escaped script tails through the real outer close or EOF', async () => {
  const escaped = '<p>safe</p><script><!--<script>nested</script>HIDDEN_SCRIPT_TAIL()-->'
  assert.equal(await extract(escaped + '</script><p>visible</p>'), 'safe\nvisible')
  assert.equal(await extract(escaped), 'safe')
  assert.equal(await extract('<p>safe</p><ScRiPt><!--<sCrIpT>nested</ScRiPt>HIDDEN_SCRIPT_TAIL()--></sCrIpT><p>visible</p>'), 'safe\nvisible')
  assert.equal(await extract('<p>safe</p><template><script><!--<script>nested</script></template>HIDDEN_SCRIPT_TAIL()--></script></template><p>visible</p>'), 'safe\nvisible')
  for (const suffix of ['<!--<script', '<!--<script>', '<!--<script>nested</script', '<!--<script>nested</script>', '<!--<script>nested</script/>tail-->']) {
    assert.equal(await extract('<p>safe</p><script>' + suffix), 'safe', suffix)
  }
})

test('script double-escape transitions accept only exact ASCII-insensitive names and tag delimiters', async () => {
  for (const delimiter of ['>', '/', ' ', '\t', '\n', '\f', '\r']) {
    assert.equal(await extract(`<p>safe</p><script><!--<ScRiPt${delimiter}ignored>nested</sCrIpT${delimiter}ignored>HIDDEN_SCRIPT_TAIL()</script><p>visible</p>`), 'safe\nvisible', JSON.stringify(delimiter))
  }
  for (const prefix of ['<scriptx>', '<script=>', '<script!>', '<script\u0000>', '<script\v>', '<script\u00a0>', '< script>', '<scr ipt>']) {
    assert.equal(await extract(`<p>safe</p><script><!--${prefix}hidden</script><p>visible</p>`), 'safe\nvisible', prefix)
  }
  for (const ending of ['</scriptx>', '</script=>', '</script!>', '</script\u0000>', '</script\v>', '</script\u00a0>', '</ script>', '</scr ipt>']) {
    assert.equal(await extract(`<p>safe</p><script><!--<script>nested${ending}HIDDEN_SCRIPT_TAIL()</script>MORE_HIDDEN</script><p>visible</p>`), 'safe\nvisible', ending)
  }
  for (const prefix of ['<!-', '<! --', '<![CDATA[']) {
    assert.equal(await extract(`<p>safe</p><script>${prefix}<script>nested</script><p>visible</p>`), 'safe\nvisible', prefix)
  }
})

test('script dash and repeated escape transitions do not leak tails or hide text after an outer close', async () => {
  for (const body of ['<script>nested', '<!--><script>nested', '<!--<script>-->', '<!--<script>--->', '<!--x--><script>nested']) {
    assert.equal(await extract(`<p>safe</p><script>${body}</script><p>visible</p>`), 'safe\nvisible', body)
  }
  for (const interruptedDashes of ['--!>', '--x>', '--\u0000>', '--<x>']) {
    assert.equal(await extract(`<p>safe</p><script><!--<script>${interruptedDashes}</script>HIDDEN_SCRIPT_TAIL()</script><p>visible</p>`), 'safe\nvisible', interruptedDashes)
  }
  assert.equal(await extract('<p>safe</p><script><!--<script><script>nested</script>HIDDEN_SCRIPT_TAIL()</script><p>visible</p>'), 'safe\nvisible')
  const repeated = '<script>nested</script>HIDDEN_SCRIPT_TAIL()'.repeat(20)
  assert.equal(await extract(`<p>safe</p><script><!--${repeated}--><!--<script>again</script>MORE_HIDDEN--></script><p>visible</p><script><!--<script>new</script>HIDDEN_SCRIPT_TAIL()</script><p>last</p>`), 'safe\nvisible\nlast')
})

test('quoted greater-than signs and tag-like attribute content cannot end tags', async () => {
  assert.equal(await extract('<p title="a > b <script>hidden</script>" data-other=\'also >\'>visible</p>tail'), 'visible\ntail')
  assert.equal(await extract('<template title="</template>">hidden</template>visible'), 'visible')
  assert.equal(await extract('<!DOCTYPE html PUBLIC "quoted > text"><p>visible</p>'), 'visible')
})

test('raw element endings require the exact ASCII-insensitive tag name', async () => {
  assert.equal(await extract('a<script>not </scriptish> still hidden</ScRiPt >b'), 'a\nb')
  assert.equal(await extract('<textarea>A<b>&amp;B</TEXTAREA><title>C<i>&#68;</title>tail'), 'A<b>&B\nC<i>D\ntail')
  assert.equal(await extract('<xmp><b>&amp;</b></xmp><plaintext><i>&amp;</i>'), '<b>&amp;</b>\n<i>&amp;</i>')
})

test('decodes common names and decimal/hex numeric references without recursive decoding', async () => {
  assert.equal(await extract('&lt;tag&gt; &amp; &quot;x&quot; &apos;y&apos;&nbsp;&copy; &#65; &#x1F680; &#X1f680; &mdash; &euro; &unknown; &amp;lt;'), '<tag> & "x" \'y\' © A 🚀 🚀 — € &unknown; &lt;')
  assert.equal(decodePublicUrlHtmlEntities('&lt; &constructor; &__proto__; &unknown; &amp;lt;'), '< &constructor; &__proto__; &unknown; &lt;')
  assert.equal(decodePublicUrlHtmlEntities('&#0; &#xD800; &#1114112; &#128; &#x110000; &#99999999999999999999999999999;'), '� � � € � �')
  assert.equal(decodePublicUrlHtmlEntities('&#; &#x; &#12x; &amp &#65 &#x41 &amp<'), '&#; &#x; &#12x; &amp &#65 &#x41 &amp<')
})

test('full-source decoding includes credentials in attributes and suppressed content', () => {
  const source = '<div data-key="s&#101;cret">x</div><!-- s&#101;cret --><script>s&#101;cret</script><template>s&#101;cret</template>'
  assert.equal(decodePublicUrlHtmlEntities(source), '<div data-key="secret">x</div><!-- secret --><script>secret</script><template>secret</template>')
})

test('conservative malformed EOF behavior suppresses unfinished markup and keeps ordinary less-than text', async () => {
  for (const suffix of ['<!-- hidden', '<script>hidden', '<style>hidden', '<noscript>hidden', '<template>hidden', '<div title="hidden > tail', '<!-->hidden', '<?unfinished hidden']) {
    assert.equal(await extract(`visible${suffix}`), 'visible', suffix)
  }
  assert.equal(await extract('1 < 2 and 3 > 2 &unterminated'), '1 < 2 and 3 > 2 &unterminated')
  assert.equal(await extract('<textarea>unterminated &amp; text'), 'unterminated & text')
  assert.equal(await extract('<template><textarea></template>still hidden'), '')
  assert.equal(await extract('safe<div ' + 'x'.repeat(100_000)), 'safe')
})

test('admits at most one MiB UTF-8 and keeps complete output bounded before caller clipping', async () => {
  const ascii = 'a'.repeat(maxSourceBytes)
  assert.equal((await extract(ascii)).length, maxSourceBytes)
  assert.equal(decodePublicUrlHtmlEntities(ascii), ascii)
  const unicode = '🚀'.repeat(maxSourceBytes / 4)
  const unicodeResult = await extract(unicode)
  assert.equal(unicodeResult, unicode)
  assert.equal(Buffer.byteLength(unicodeResult), maxSourceBytes)
  for (const value of ['a'.repeat(maxSourceBytes + 1), '雪'.repeat(Math.ceil(maxSourceBytes / 3)), null, 42]) {
    await assert.rejects(extract(value), error => error.code === 'invalid_extraction' && error.message === 'HTML extraction did not complete')
  }
  for (const value of [null, 42]) assert.throws(() => decodePublicUrlHtmlEntities(value), error => error.code === 'invalid_extraction')
  const markup = '<br>x'.repeat(Math.floor(maxSourceBytes / 5))
  assert(Buffer.byteLength(await extract(markup)) <= 2 * maxSourceBytes)
  // HTML's NUL-to-replacement-character rule is a real output expansion. The
  // extractor must fail closed rather than return or truncate an oversized text.
  await assert.rejects(extract('\u0000'.repeat(maxSourceBytes)), error => error.code === 'invalid_extraction')
  const boundedExpansion = await extract('\u0000'.repeat(100_000))
  assert.equal(Buffer.byteLength(boundedExpansion), 300_000)
  assert.equal(boundedExpansion, '\ufffd'.repeat(100_000))
  const expandedForScreening = await extract('\u0000'.repeat(400_000))
  assert.equal(Buffer.byteLength(expandedForScreening), 1_200_000)
  assert.equal(decodePublicUrlHtmlEntities(expandedForScreening), expandedForScreening)
  await assert.rejects(extract('\u0000'.repeat(700_000)), error => error.code === 'invalid_extraction')
  const numericNul = '&#0;'.repeat(200_000)
  assert.equal(Buffer.byteLength(await extract(numericNul)), 600_000)
})

test('full-source decoder admits the complete two-MiB extraction bound and rejects larger inputs', () => {
  const input = 'a'.repeat(2 * maxSourceBytes)
  assert.equal(decodePublicUrlHtmlEntities(input), input)
  const unicode = '🚀'.repeat(2 * maxSourceBytes / 4)
  assert.equal(decodePublicUrlHtmlEntities(unicode), unicode)
  for (const value of ['a'.repeat(2 * maxSourceBytes + 1), '雪'.repeat(Math.ceil(2 * maxSourceBytes / 3))]) {
    assert.throws(() => decodePublicUrlHtmlEntities(value), error => error.code === 'invalid_extraction' && error.message === 'HTML extraction did not complete')
  }
})

test('extractor calls guard throughout each tokenizer mode and propagates cancellation unchanged', async () => {
  const stop = Object.assign(new Error('Cancelled'), { code: 'cancelled' })
  for (const value of ['a'.repeat(100_000), '<!--' + 'x'.repeat(100_000), '<script>' + 'x'.repeat(100_000), '<script><!--' + 'x'.repeat(100_000), '<script><!--<script>' + 'x'.repeat(100_000), '<script><!--' + '<script>hidden</script>'.repeat(5_000), '<template>' + 'x'.repeat(100_000), '<p title="' + 'x'.repeat(100_000), '<!DOCTYPE "' + 'x'.repeat(100_000)]) {
    let calls = 0
    await assert.rejects(extractPublicUrlHtml(value, () => { if (++calls === 4) throw stop }), error => error === stop)
    assert.equal(calls, 4)
  }
  let calls = 0
  assert.throws(() => decodePublicUrlHtmlEntities('a'.repeat(100_000), () => { if (++calls === 3) throw stop }), error => error === stop)
  assert.equal(calls, 3)
})

test('setImmediate cooperation lets an external cancellation interrupt CPU-bound extraction', async () => {
  const stop = new Error('External cancellation')
  for (const value of ['<template>' + 'x'.repeat(500_000), '<script><!--' + 'x'.repeat(500_000), '<script><!--<script>' + 'x'.repeat(500_000), '<script><!--' + '<script>hidden</script>'.repeat(20_000)]) {
    let cancelled = false
    setImmediate(() => { cancelled = true })
    await assert.rejects(extractPublicUrlHtml(value, () => { if (cancelled) throw stop }), error => error === stop)
    assert.equal(cancelled, true)
  }
})

test('script escape tracking stays bounded at the full source limit and with long false names', async () => {
  const prefix = '<p>safe</p><script><!--<script>'
  const suffix = '</script>HIDDEN_SCRIPT_TAIL()--></script><p>visible</p>'
  const value = prefix + 'x'.repeat(maxSourceBytes - prefix.length - suffix.length) + suffix
  assert.equal(Buffer.byteLength(value), maxSourceBytes)
  assert.equal(await extract(value), 'safe\nvisible')
  await assert.rejects(extract(value + 'x'), error => error.code === 'invalid_extraction')
  assert.equal(await extract('<p>safe</p><script><!--<script' + 'x'.repeat(100_000) + '>hidden</script><p>visible</p>'), 'safe\nvisible')
  assert.equal(await extract(prefix + '</script' + 'x'.repeat(100_000) + '>hidden' + suffix), 'safe\nvisible')
})

test('one-MiB adversarial ampersands and long names remain linear and safely bounded', async () => {
  const input = '&'.repeat(maxSourceBytes)
  assert.equal(await extract(input), input)
  assert.equal(decodePublicUrlHtmlEntities(input), input)
  assert.equal(await extract('<' + 'a'.repeat(100_000) + '>visible'), 'visible')
})
