# paperclip-haee-adapter

Paperclip external adapter for **HAEE** (Holon Agent Execution Environment) agents exposed at `/acp` over WebSocket.

Paperclip owns goals, issues, heartbeats, and the run-scoped tool/skill projection. HAEE runs the model turn. This package is the thin bridge: map `execute(ctx)` → ACP session params, stream run events, settle/cancel cleanly.

HAEE is a ZeroClaw-derived runtime ([holarchy-cloud/haee](https://github.com/holarchy-cloud/haee)); the CLI binary name remains `zeroclaw`. This adapter speaks ACP v1 and requires Node.js 22+.

## Status

| Item | Value |
| --- | --- |
| Package | `paperclip-haee-adapter` **@0.1.9** (envelope emit + skill packs; pair with HAEE Iter 0–9 tip) |
| Paperclip adapter type id | `zeroclaw_acp` (kept for lab continuity; rename later) |
| Runtime target | HAEE with nested run `envelope` (`tools.paperclipToolsOnly` + `tools.mcpServers` + `skills[]`) |
| Lab gate | Isolation hire still open until HAEE binary + this adapter are pair-deployed (ElEl #6) |
| License | MIT (same SPDX family as Paperclip AI) |

## Install

1. Run an **HAEE** daemon with ACP enabled and a named agent. Make its gateway reachable at `wss://HOST/acp` or `ws://localhost:PORT/acp`. For a Windows host reached from WSL in NAT mode, use `ws://WINDOWS_HOST_IP:PORT/acp` and enable `allowPlainPrivateWs`. This exception only accepts RFC1918 IPv4 addresses; it sends the gateway token over the private WSL host network without TLS.
2. Put the gateway token in the Paperclip server environment as `ZEROCLAW_ACP_TOKEN`. The adapter sends it through the runtime’s documented `?token=` authentication, so keep reverse proxy query logging disabled and use TLS remotely.
3. Register this package through Paperclip’s Adapter Manager or `POST /api/adapters/install` with JSON `{"packageName":"/absolute/path/to/paperclip-haee-adapter","isLocalPath":true}`. Select adapter type `zeroclaw_acp` for an agent.
4. Configure `url` and `agentAlias`. In WSL NAT mode, enable `allowPlainPrivateWs`. Optionally set `cwd` to an existing workspace path **on the HAEE host**.
5. Configure Paperclip’s Tool Gateway and grant the required tools to the agent. Paperclip supplies the invocation-scoped HTTP MCP endpoint and token to the adapter at runtime; no Paperclip API key is placed in the HAEE prompt or saved in session metadata.

The adapter initializes ACP, resumes the prior session when present, or creates a new one. It sends a nested run `envelope` on each session request (identity, auth, tools, policy, session) as the sole tools/auth authority—no discarded top-level `paperclipToolsOnly` / `mcpServers` dual-write. It sends the wake context as a prompt, streams text/tool status into Paperclip’s run log, and closes the active session while preserving its history. It sends `session/cancel` on operator cancellation and declines `session/request_permission` requests; no human approval bridge is implemented. Runtime usage/costs are not reported by this ACP surface. A failed resume fails the run rather than silently starting a fresh session and repeating work.

```bash
npm test
```

Exercises new and resumed sessions against a mock ACP socket.

## Invocation-scoped task tools

Set `taskMcpBindHost` (or server environment `ZEROCLAW_TASK_MCP_BIND_HOST`)
to the Paperclip host’s Tailscale IPv4 address. The adapter starts an ephemeral
HTTP MCP listener on that address for each task-bound run. HAEE must reach
the selected port over Tailscale; HTTP is protected by Tailscale’s encrypted
transport and a fresh per-invocation bearer. Public/wildcard bind addresses are
rejected. `127.0.0.1` is supported for same-host execution and tests only.

When Paperclip materializes `config.paperclipRuntimeSkills` (key, runtimeName,
source directory), the same bind host also publishes short-lived skill pack
tarballs. Each pack is hashed (sha256 + sizeMax), listed in envelope `skills[]`
with a private `http://` URL, and revoked when the run ends. Fetch authorization
is a single-use path token (not logged in the wake prompt). Without a bind host,
skill packs are omitted rather than emitting `file://` paths HAEE cannot read.

The adapter privately relays narrow task tools to the existing Paperclip API
using `ctx.authToken` and `X-Paperclip-Run-Id`, following the local adapters’
authentication and callback-bridge patterns. It declares `supportsLocalAgentJwt`
so Paperclip supplies a current-run JWT, and `runtimeToolDelivery: native_mcp`
so connection-intent tools are delivered as actual MCP tools rather than
credential-bearing wake-context data. `taskApiUrl` can override the
local API origin; otherwise the Paperclip listen host/port are used. It is not
a generic HTTP proxy and does not mint agent credentials or bypass API policy.
The listener and in-flight requests are revoked on cancellation and closed
before `execute()` returns. Resumed sessions receive a fresh endpoint/token.

ACP server identifiers are `paperclip_tasks` for the task bridge and
`paperclip_broker_1`, `paperclip_broker_2`, etc. for supplied servers in their
current order. They are transport-local identifiers, not Paperclip display
names or connection identities; URLs, credentials, and grants are unchanged.
HAEE/ZeroClaw prefixes each tool with `<server>__`, and some providers omit
names that do not match `^[a-zA-Z0-9_-]{1,64}$`. Short, distinct identifiers
avoid prefix failure and collisions between repeated display names.

Wake instructions require the exact advertised names and argument schemas,
including the MCP prefix. Lifecycle operation names in the instructions are
not unprefixed callable names. Printed JavaScript or JSON is not a tool call.

The task bridge fills gaps in the supplied agent-run MCP tools; it does not
duplicate `set_task_title` or `create_task`. Those remain on Paperclip’s supplied
project-tools server. Paperclip’s public OAuth MCP finish operation acts as the
connected person, not the invoked agent, and is not a replacement for the
authenticated current-run bridge.

Paperclip’s supplied project-tools server makes downstream requests using its
runtime `PAPERCLIP_API_URL`. This must be reachable from the Paperclip server
itself as well as from HAEE. When Paperclip binds only to Tailscale, neither
loopback nor a short hostname resolving to another interface is sufficient.
Set an explicit reachable origin (for example the full MagicDNS hostname with
the listening port) in Paperclip’s service environment. This does not change
the public authentication base URL or weaken tool authorization.

Tools cover current-task reads, bounded history, checkout,
durable progress/results, completion, dependency/agent-owned blockers, and
human questions/confirmations with saved waiting paths. The server’s actual
status is returned: a completion request can remain `in_review` under review
gates. Ask/Plan modes cannot complete/block/check out work; conversation tasks
do not receive execution disposition tools. No automatic completion is inferred
from model prose. A failed or ambiguous write is reported explicitly and is
not repeated with the same invocation idempotency key; inspect current state
before deciding on further action. Receipts are invocation-local, not durable
cross-run deduplication.

### Missing task/run authentication

For a task-bound invocation with the task listener enabled, the adapter requires
`ctx.authToken`, `ctx.runId`, `ctx.agent.id`, and `ctx.agent.companyId`.
Missing fields are named in the failure before connecting to HAEE.
The adapter does not mint a Paperclip JWT or recover one from task text,
saved session state, adapter config, or the ACP gateway token.

If `ctx.authToken` is missing, verify that Paperclip loaded the current adapter
factory with `supportsLocalAgentJwt: true`. Paperclip’s legacy adapter execution
path mints the JWT using its server-side `PAPERCLIP_AGENT_JWT_SECRET`, falling
back to `BETTER_AUTH_SECRET`. Without a signing secret it can invoke the adapter
without a JWT; this adapter rejects that task-bound invocation. Check secret
presence locally without displaying its value. Changing files on disk alone
does not establish which module the running Paperclip process has loaded.
The capability declaration is already present; do not substitute a static
agent key or forward Paperclip’s signing secret to HAEE.

Without a bind address the adapter continues to forward only supplied MCP
servers, preserving empty-catalog isolation tests. Tool availability is checked
against current task ownership on every call. Wake prompts omit transport
metadata and redact current credentials.

## HAEE compatibility

This integration requires an HAEE build that accepts nested run `envelope` on
ACP `session/new` | `session/resume` (Iteration 4+). Adapter 0.1.8+ no longer
sends discarded top-level tools fields. Stock upstream ZeroClaw does not consume
the envelope. Do not deploy this adapter against an unmodified stock runtime or
an HAEE binary that only understands the old top-level tools fields: adapter and
HAEE must be rolled out together.

For a Paperclip-scoped ACP session, HAEE connects only the envelope-listed HTTP
MCP servers and exposes only tools advertised by those servers. Built-in tools and
saved agent MCP bundles are excluded from that session. A missing/empty
brokered catalog therefore gives the model no tools; it does not fall back to
generic HTTP, shell, or globally configured MCP. Standalone sessions keep their
existing tool configuration.

The envelope carries the current Paperclip run bearer and MCP headers. Tokens are
not included in the prompt or persisted session parameters. Verify this property
and the server-side Tool Gateway policy/audit for each deployment. The adapter’s
environment check validates ACP connectivity only; it does not validate Tool
Gateway access or issue completion.

## Related

- Runtime: [holarchy-cloud/haee](https://github.com/holarchy-cloud/haee)
- Control plane: [paperclipai/paperclip](https://github.com/paperclipai/paperclip)
- Design: run envelope / session policy (ElEl `docs/plans/haee-run-envelope.md`)

## License

[MIT](LICENSE)
