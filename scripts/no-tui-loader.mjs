// SPDX-License-Identifier: Apache-2.0
/** Test-only guard: installed Node routes must not resolve the native TUI or parser. */
export async function resolve(specifier, context, nextResolve) {
  const forbidden = value => /(?:^|\/)@opentui\//.test(value) ||
    /(?:^|\/)web-tree-sitter(?:\/|$)/.test(value) ||
    /(?:^|[/\\])tui\.(?:js|ts)(?:[?#]|$)/.test(value)
  if (forbidden(specifier)) {
    throw new Error('Node line-mode acceptance attempted to import the native TUI')
  }
  const result = await nextResolve(specifier, context)
  if (forbidden(result.url)) throw new Error('Node line-mode acceptance attempted to import the native TUI')
  return result
}
