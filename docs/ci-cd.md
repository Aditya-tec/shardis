# CI/CD Operations

## Required GitHub settings

Branch protection is a repository setting, not something a workflow can
enforce by itself. For `main`, configure a ruleset or branch protection rule
with:

- Require a pull request before merging.
- Require at least one approving review.
- Dismiss stale approvals when new commits are pushed.
- Require status checks before merging:
  - `test`
  - `compose-smoke`
  - `Analyze TypeScript`
  - `Gitleaks`
- Require branches to be up to date before merging.
- Block force pushes and branch deletion.
- Do not allow bypassing the rule except for a deliberate administrator break-
  glass policy.

Open **Settings -> Rules -> Rulesets** in the repository and apply these
requirements to `main`. Check the exact check names in the Actions UI after
the first run because GitHub uses each job's displayed name as the required
status context.

## Workflows

- `ci.yml` runs on pushes and pull requests. It audits dependencies, builds
  every package, runs all tests, and starts the six-node Compose cluster for a
  real CLI write/read smoke test.
- `codeql.yml` scans TypeScript on pushes, pull requests, and weekly.
- `secrets.yml` runs Gitleaks on pushes, pull requests, and weekly.
- `nightly-chaos.yml` starts Compose, writes data, SIGKILLs `node-a1`, asserts
  `node-a2` promotion and post-failover writes, restarts `node-a1`, and always
  removes the cluster.
- `chaos-bench.yml` remains the manual/weekly benchmark workflow and records
  dated benchmark results.
- `release.yml` publishes `ghcr.io/<owner>/shardis` for tags matching
  `v*.*.*`.

## Security boundary

The node uses plain `ws://` internally. TLS is expected to terminate at the
reverse proxy or managed platform in front of it; clients should only receive
`wss://` endpoints. Do not add a public node port without TLS termination.

## Release process

```bash
git tag v1.0.0
git push origin v1.0.0
```

The tag workflow publishes version, major/minor, and `latest` image tags.
Production deployment remains an explicit platform operation; no workflow
automatically changes Render or Vercel state.