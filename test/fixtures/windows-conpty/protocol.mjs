// SPDX-License-Identifier: Apache-2.0
// Synthetic probes only. Nothing here reads a user's keyboard or clipboard.
export const record = (vk, scan, character, down = 1, state = 0, repeat = 1) =>
  `\x1b[${vk};${scan};${character};${down};${state};${repeat}_`
export const tap = (vk, scan, character, state = 0) =>
  record(vk, scan, character, 1, state) + record(vk, scan, 0, 0, state)
export const pasteText = 'conpty-fixture\rnext\n\u4e2d\u6587\ud83d\ude42'
export const paste = `\x1b[200~${pasteText}\x1b[201~`
export const basicProbes = tap(13, 28, 13) + tap(13, 28, 13, 16) + tap(74, 36, 10, 8)
export const repeatProbes = record(13, 28, 13, 1, 16, 3) + record(13, 28, 13, 1, 16) +
  record(13, 28, 0, 0, 16) + tap(13, 28, 13, 16)
// Escape down closes the reader; sending its release could race the post-close probe.
export const finish = record(27, 1, 27)
export const restorationProbe = tap(13, 28, 13, 16)
export const expectedProbes = [
  ['enter', false, false, 'press', 'kitty'],
  ['enter', true, false, 'press', 'kitty'],
  ['ctrl-j', false, true, 'press', 'kitty'],
  ['enter', true, false, 'press', 'kitty'],
  ['enter', true, false, 'repeat', 'kitty'],
  ['enter', true, false, 'repeat', 'kitty'],
  ['enter', true, false, 'repeat', 'kitty'],
  ['enter', true, false, 'press', 'kitty']
]
