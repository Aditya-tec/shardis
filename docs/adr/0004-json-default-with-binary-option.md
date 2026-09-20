# ADR 0004: JSON Default Protocol with an Opt-in Binary Codec

## Context

The wire protocol should be easy to inspect while still demonstrating how a compact framing can coexist with the same operations and responses.

## Decision

Use one JSON message per WebSocket frame by default. Support an opt-in compact binary codec for clients that choose it; responses preserve the framing of the incoming request.

## Consequences

JSON keeps manual testing, dashboard inspection, and failure debugging straightforward. The binary mode exposes protocol design and avoids tying the project to JSON alone. Maintaining both codecs adds test surface and requires them to remain semantically aligned.

## Alternatives considered

- **JSON only:** smallest surface area, but no compact-protocol demonstration.
- **Binary only:** potentially smaller frames, but less transparent and harder to debug.
- **HTTP/REST:** simpler for basic CRUD, but a poor match for persistent replication, subscriptions, and WebSocket client behavior.
