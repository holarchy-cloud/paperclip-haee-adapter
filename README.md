# Paperclip → ZeroClaw ACP adapter

A Paperclip external adapter for persistent ZeroClaw agents exposed at `/acp` over WebSocket. Paperclip owns goals, issues and heartbeat scheduling; ZeroClaw runs the turn. The adapter speaks ACP v1 directly and requires Node.js 22+.

## Install

1. Run a ZeroClaw daemon with ACP enabled and a named agent. Make its gateway reachable at `wss://HOST/acp` or `ws://localhost:PORT/acp`. For Windows ZeroClaw reached from WSL in NAT mode, use `ws://WINDOWS_HOST_IP:PORT/acp` and enable `allowPlainPrivateWs`. This exception only accepts RFC1918 IPv4 addresses; it sends the gateway token over the private WSL host network without TLS.
2. Put the gateway token in the Paperclip server environment as `ZEROCLAW_ACP_TOKEN`. The adapter sends it through ZeroClaw's documented `?token=` authentication, so keep reverse proxy query logging disabled and use TLS remotely.
3. Register this package through Paperclip's Adapter Manager or `POST /api/adapters/install` with JSON `{"packageName":"/absolute/path/to/paperclip-zeroclaw-adapter","isLocalPath":true}`. Select adapter type `zeroclaw_acp` for an agent.
4. Configure `url` and `agentAlias`. In WSL NAT mode, enable `allowPlainPrivateWs`. Optionally set `cwd` to an existing workspace path **on the ZeroClaw host**.
5. Set `paperclipApiUrl` to the Paperclip URL reachable from the ZeroClaw host (for Windows with WSL localhost forwarding, `http://127.0.0.1:3100`). Configure ZeroClaw `[http_request]` with this host in `allowed_domains` and `allowed_private_hosts`; set `[http_request.secrets] paperclip = "${PAPERCLIP_AGENT_AUTH}"`, where the gateway process environment variable contains `Bearer <dedicated Paperclip agent API key>`. Allow `http_request` on the agent's risk profile. The adapter supplies the URL, named secret, and current run ID as instructions without transmitting the API key or Paperclip's scoped run token.

The adapter initializes ACP, resumes the prior session when present, or creates a new one, sends each Paperclip wake context as a prompt, streams text/tool status into Paperclip's run log, closes the active session while preserving its history, returns the persistent session ID, and sends ZeroClaw's `session/cancel` notification on operator cancellation. It declines `session/request_permission` requests; no human approval bridge is implemented. ZeroClaw usage/costs are not reported by this ACP surface. A failed resume fails the run rather than silently starting a fresh session and repeating work.

Run `npm test` to exercise new and resumed sessions against a mock ACP socket.
