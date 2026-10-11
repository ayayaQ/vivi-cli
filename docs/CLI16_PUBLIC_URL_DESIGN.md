# CLI-16: bounded public-page retrieval

The user accepted the public-pages-only scope and Auto decision checker with
manual fallback on uncertainty or failure on 2026-10-10. This implements one
`fetch_url` CLI tool, with no reusable core change or search provider. The earlier
[draft design receipt](https://github.com/ayayaQ/vivi-cli/pull/37#issuecomment-6103264611)
is historical offline evidence, not production proof.

## Fixed first slice

- One explicit URL and fixed HTTPS GET on port 443; no caller headers, cookies,
  browser login, JavaScript, proxy routing, crawl, upload, search or downloads
- Manual is the default; freshly enrolled Auto can review eligible ordinary
  non-sensitive exact requests through the selected existing provider
- Hard URL/address/credential policy blocks cannot be overridden by a judge or
  human confirmation; uncertain, sensitive or failed review stays manual
- Three redirects maximum, every target revalidated and freshly resolved; a
  changed origin requires a distinct exact-destination host admission
- 15 seconds cumulative active work, excluding decision pauses; 16 KiB headers,
  1 MiB body and at most 64 KiB UTF-8 extracted text **and complete JSON result**
- Identity encoding only; compressed responses and unsupported MIME/charsets
  fail closed. Supported types are UTF-8 plain text, JSON and inert HTML text

Approval discloses the complete transmitted URL, method, destination, redirect
scope and limits. Paths and queries may reveal private data; DNS receives the
hostname, and the destination observes caller IP and request metadata. GET can
have server-side effects or costs. The public-address filter is conservative
admission policy, not OS network isolation or a guarantee about external routing.

## Real admission and transport

The fixed extension name is reserved even while disabled. It is advertised only
with tool support and a durable outcome sink. CLI file sessions supply a private
sidecar automatically; custom hosts must supply their own sink. Trusted fixture
adapters are host options, never model arguments or recovered settings.

The host binds the exact captured tool call, session/run, tool availability,
transport references, selected account, enrolled policy/sharing revisions and
host-prepared network effect. It repeats ownership, secrets and the reviewed
receipt before DNS, queued durable intent replacement and socket admission.
Same-origin redirects are covered only by the disclosed bounded rule. Cross-origin
admission uses a new ID bound to the original occurrence and exact destination.

Reject userinfo, dotless/local names, non-public/special IP ranges, conventional
credential query keys and known secrets in raw and repeatedly decoded URLs.
Fragments are screened before removal. Resolve bounded A/AAAA answers using one
owned cancellable resolver; mixed public/private, empty or oversized results are
blocked. Pin one admitted IP with no fallback lookup, retaining original Host/SNI
and certificate identity. TLS trust remains mandatory; IP identities use IP SANs.
No retry, automatic redirect or environment proxy can bypass this direct adapter.

The real HTTP parser enforces header bounds and rejects ambiguous singleton
headers/framing. The stream and extractor are bounded, deadline-owned and closed
on failure/cancellation. Closed errors expose no native error, URL, header or body.
Complete metadata/source/extracted content is screened before output clipping;
new credentials invalidate pending admission and withhold canonical content.
Detection is conservative and incomplete, not a guarantee of finding all secrets.

## Text, provenance and outcomes

HTML uses a linear inert tokenizer, not browser rendering or a full HTML5 DOM.
It does not execute or fetch anything. Script/style/raw suppressed elements,
comments and templates are omitted; malformed unfinished suppressed regions stay
omitted. Common named entities plus numeric entities are decoded; unknown names
and missing semicolons remain literal. The explicit representation version records
this subset. Fixed work quanta yield and recheck cancellation/deadline. The entire
bounded extraction is screened before its transcript-sized prefix is returned.

Success records requested/final URL, redirects, HTTP status, MIME, timestamp,
bytes read, body SHA-256, representation/version and truncation. Source text,
headers, links and approval-shaped payloads remain untrusted data, never authority.
Transmission evidence is separate from retrieval success and unknown server
side effects. A local completed write is `observed`, not proof of remote effects.

A private fsynced sidecar records send intent before HTTP admission and the exact
settled result afterward. Missing settlement recovers as unknown with `doNotRetry`;
no receipt is persisted or restored. Cancelled runs drain their owned operations
before final history reconciliation. Any attempted result carries `doNotRetry`,
and repeated same-URL attempts in one run are blocked. A new explicit user turn
needs a fresh admission. Evidence is retired only after a matching transcript
checkpoint; a cleanup failure retains evidence without enabling replay.

## Verification boundaries

The former mock helper and product-hash freeze are removed. Contract fixtures now
exercise the actual product engine; separate suites test the tokenizer, real
DNS/TLS/HTTP adapter with controlled dependencies, actual host admission, Auto
fallback/enrollment, durable outcomes and recovery. They run on Node and Bun, with
explicit Windows Node/Bun fixture lanes. No live keys, external-site requests,
private-network bypass or historical excluded filesystem assessments are needed.

Final completion requires fresh independent exact-tree review, full tests/types,
installed package/declarations/bin, standalone/native CI and guarded merge with
post-main checks. Controlled TLS/socket and provider fixtures do not establish
external-site behavior, real-model judgment accuracy, hostile OS/network isolation,
or interactive native vault/TTY acceptance. Those remain separately recorded
coverage, rather than claims inferred from fixture success.

Sources: [CLI-16 card](https://chatgpt.com/space/page_2b5f7c8515848191985cc32f01cd94c8),
[Node HTTPS](https://nodejs.org/api/https.html#httpsrequesturl-options-callback),
[Node DNS resolver](https://nodejs.org/api/dns.html#class-dnspromisesresolver),
[Node TLS identity](https://nodejs.org/api/tls.html#tlscheckserveridentityhostname-cert),
[IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/),
[IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/),
[HTTP semantics](https://httpwg.org/specs/rfc9110.html#safe.methods).
