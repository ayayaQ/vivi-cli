# CLI-16: public URL retrieval design checkpoint

Status: proposed policy and offline contract fixtures only. No runtime tool,
network adapter, catalog registration, dependency, or public API is added here.
The privacy/network decision is still pending. This is not live acceptance.

## Small first slice

One `fetch_url` tool retrieves one explicitly selected URL, using a fixed GET.
There is no search provider, account login, cookie jar, caller-supplied header,
JavaScript execution, browser automation, recursive crawl, or workspace upload.
Provider-backed search is a separate later choice with its own disclosure/costs.

Proposed defaults, requiring a product decision before exposure:

- HTTPS on port 443 only; no certificate-warning bypass or proxy routing
- Human review for every initial request, including Auto; this is a proposal,
  not a claim that the existing Auto policy already authorizes URL requests
- At most three redirects; revalidate every destination and freshly resolve
  it; a change of origin requires another exact-destination human approval
- 15 seconds cumulative active lookup/response work; human approval pauses do
  not consume it, and every resumed request rechecks ownership/admission
- 16 KiB response headers, 1 MiB body, 64 KiB extracted UTF-8 text
- Initially request identity encoding and reject compressed responses; supporting
  compression later requires separate compressed and expanded stream budgets
- UTF-8 `text/plain`, `application/json`, and `text/html`; HTML extraction needs
  a reviewed inert parser, not regex stripping; binary/PDF/XML/downloads deferred

If synchronous extraction can outrun cancellation, use one fixed reviewed,
deadline-owned extractor worker; external content supplies data, never code.

The approval discloses the full transmitted URL, method, redirect rule and limits.
Queries and paths may reveal private data; DNS reveals the host, and a web server
can observe the caller's IP and request metadata. GET is not a guarantee of no
server-side effect. Private/sensitive URL transmission needs the appropriate
specific authorization; credential-bearing URLs remain blocked.

## Admission and transport boundaries

Reject userinfo, local/dotless hostnames, non-public/special addresses, and known
credentials before DNS or approval display. Check raw and repeatedly decoded
URLs, redirect locations, admitted response metadata and complete bounded body
before clipping. Conventional credential query names are a conservative extra
block, not complete secret detection. Fragments are screened before removal.

After approval, check the current session/run, enabled-tool state, exact argument
digest and policy revision again at actual admission. Resolve all candidate
addresses; reject an empty, invalid, oversized, or mixed public/private answer.
Pin the connection to one admitted IP while retaining the original hostname for
Host/SNI and certificate validation. A separate second lookup is not sufficient.
No global fetch, environment proxy, address fallback, authentication retry,
automatic request retry, or implicit redirect following may evade this boundary.
Destroy sockets/streams on cancellation, deadline, invalid headers/type or budget
failure. DNS work that cannot be physically cancelled must never enter transport
after ownership/deadline loss. An IP filter alone is not network isolation or a
claim about hostile routing, operating-system resolver behavior or arbitrary sites.

Result fields include requested/final URL, redirect chain, HTTP status, MIME,
retrieval timestamp, bytes read, body digest, representation/extraction version,
text truncation and untrusted-source marking. Keep request transmission evidence
separate from successful retrieval and from unknown server effects. Closed
host-authored errors must not expose thrown URLs, headers or response bodies.
Source text, embedded instructions, redirects and result metadata grant no rights.

## Integration and remaining proof

Use the existing run-owned extension scope, host approval controller and shared
presentation/event contracts. Reserve the name even while disabled. A concrete
CLI adapter is enough; demonstrate a reusable need before moving anything to core.
Do not enlarge Auto's enrolled sharing/policy scope without an explicit decision
and new consent. Session changes/exit must revoke pending admission and drain
owned network work. Recovery must not restore approval or replay requests.

The test-only prototype injects approval, resolver, transport and optional HTML
extraction. Fixtures exercise proposed URL/IP checks, redirects, stale ownership,
known-secret screening, deadline/cancellation, bounded text and honest outcomes.
Its generic current-owner predicate is not real session/run/digest/policy binding.
They do not verify DNS pinning, real TLS, HTTP framing, HTML parsing, durable host
outcomes, proxy behavior or real providers. Those require the final adapter,
actual-host tests, independent exact-tree review, full package/types/native CI,
and separately recorded live/manual acceptance after policy confirmation.

Sources: [CLI-16 card](https://chatgpt.com/space/page_2b5f7c8515848191985cc32f01cd94c8),
[Node HTTPS](https://nodejs.org/api/https.html#httpsrequesturl-options-callback),
[Node DNS](https://nodejs.org/api/dns.html#dnslookuphostname-options-callback),
[IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/),
[IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/),
[HTTP semantics](https://httpwg.org/specs/rfc9110.html#safe.methods).
