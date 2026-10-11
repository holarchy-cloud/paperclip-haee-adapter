# HAEE run-envelope fixtures (v1)

**Canonical copy** for Iteration 1+. Logical schema only — not ACP wire wrappers.

Design authority: [haee-run-envelope.md](../../haee-run-envelope.md)  
Implementation plan: [haee-envelope-implementation.md](../../haee-envelope-implementation.md)  
Wire choice: **ACP `session/new` | `session/resume` params** with nested `envelope` only (see design §8 implementation note). No top-level tools dual-write.

## Layout

| File | Class | Purpose |
|---|---|---|
| `valid-minimal-tools-only.json` | valid | Lab-shaped tools-only envelope (empty skills) |
| `valid-full-v1.json` | valid | Full v1: identity, task, auth, skills[], tools, policy, session |
| `invalid-bad-version.json` | invalid | `envelopeVersion` ≠ 1 |
| `invalid-non-http-mcp.json` | invalid | MCP `type` not `http` |
| `invalid-empty-mcp-name.json` | invalid | empty MCP name |
| `invalid-empty-mcp-url.json` | invalid | empty MCP url |
| `invalid-paperclip-tools-only-false.json` | invalid | Paperclip session without `paperclipToolsOnly: true` |
| `invalid-skill-missing-integrity.json` | invalid | remote skill ref without integrity |
| `invalid-skill-oversize-meta.json` | invalid | skill `sizeMax` exceeds implementer hard cap (fixture uses 1 GiB+1) |

Duplicates for loaders:

- Adapter: `src/paperclip-haee-adapter/fixtures/haee-run-envelope/`
- HAEE: `src/haee/tests/fixtures/haee_run_envelope/`

Keep the three trees **byte-identical** for JSON files until a single package owns them.

## Field mapping (`AdapterExecutionContext` → envelope)

| Envelope field | Source |
|---|---|
| `identity.runId` | `ctx.runId` |
| `identity.agentId` | `ctx.agent.id` |
| `identity.companyId` | `ctx.agent.companyId` |
| `identity.haeeAgentAlias` | `ctx.config.agentAlias` (bootstrap default if omitted on wire) |
| `task.issueId` | `ctx.context.issueId` / task id helpers when present |
| `task.wakeReason` | wake / heartbeat reason when present |
| `task.summary` | short non-secret summary; full body stays in ACP prompt |
| `task.acceptanceHints` | optional |
| `auth.paperclipApiBaseUrl` | adapter config / reachable Paperclip origin from HAEE |
| `auth.runBearerToken` | `ctx.authToken` (**never** in prompt/logs) |
| `auth.runIdHeader` | `"X-Paperclip-Run-Id"` |
| `skills[]` | run skill refs (uri+integrity); empty until skill plane ships |
| `tools.paperclipToolsOnly` | always `true` for Paperclip-originated sessions |
| `tools.mcpServers` | `ctx.runtimeMcp.getServers()` + optional task-MCP listener |
| `policy.riskProfile` | adapter/agent config (lab: may match HAEE profile name) |
| `session.resumeSessionId` | prior ACP session id |
| `session.cwd` | `ctx.config.cwd` when set |

### MCP header encoding note

Design logical shape uses object headers:

```json
"headers": { "Authorization": "Bearer RUN_TOKEN_PLACEHOLDER" }
```

Task-MCP internal listener may still use array headers locally; **envelope wire form uses object headers** as in these fixtures.

### ACP wire shape (not stored in these fixtures)

```text
session/new | session/resume params:
  envelope: { … entire fixture … }  # sole tools/auth authority
  agentAlias?, cwd?, sessionId?     # existing ACP placement fields only
  # no top-level paperclipToolsOnly / mcpServers
```

## Expected invalid error classes

Stable **class** names for HAEE parse (Iteration 2). Exact message text may vary; class must not.

| Fixture | Expected class |
|---|---|
| `invalid-bad-version.json` | `envelope_version_unsupported` |
| `invalid-non-http-mcp.json` | `mcp_type_unsupported` |
| `invalid-empty-mcp-name.json` | `mcp_name_invalid` |
| `invalid-empty-mcp-url.json` | `mcp_url_invalid` |
| `invalid-paperclip-tools-only-false.json` | `paperclip_tools_only_required` |
| `invalid-skill-missing-integrity.json` | `skill_integrity_required` |
| `invalid-skill-oversize-meta.json` | `skill_size_max_exceeded` |

Hard cap used by oversize fixture meta: **`sizeMax` must be ≤ 104857600 (100 MiB)** for v1 validators (document in HAEE parse). Fixture sets `1073741825` (1 GiB + 1).

## Placeholders (not secrets)

All tokens/URLs in fixtures are lab-shaped placeholders:

- `RUN_TOKEN_PLACEHOLDER`, `TASK_MCP_TOKEN_PLACEHOLDER`
- Hosts: `http://paperclip.wombat-everest.ts.net:3100`, `http://100.115.49.38:…`

Do not replace with real lab credentials in git.
