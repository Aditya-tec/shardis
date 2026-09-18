# Security Policy

## Supported versions

Only the `main` branch is currently supported with security fixes. Shardis is
an experimental distributed-systems project, not a production security
boundary or a managed service.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
**Report a vulnerability** action on the repository's Security tab so the
details remain private while the issue is investigated.

Include:

- the affected commit, package, or deployment mode;
- reproducible steps or a minimal proof of concept;
- impact and any required configuration; and
- a suggested mitigation, if known.

Do not include real credentials, private keys, or customer data in reports.
Redact them and rotate any secret that may have been exposed immediately.

## Deployment security model

The node accepts plain `ws://` connections and does not terminate TLS
in-process. Production deployments must place it behind a TLS-terminating
reverse proxy or managed platform endpoint and expose only `wss://` to clients.
Do not expose a node's plain WebSocket port directly to the public internet.

Local Docker Compose is intentionally open for development. Public-demo
deployments additionally require `PUBLIC_DEMO=true` and `DEMO_WRITE_KEY` for
writes, but that shared key is not a multi-tenant identity system.