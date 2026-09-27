# ADR-018: Own minimal LSP client with managed server installation

Status: accepted (2026-09-26)

## Context

Official `*-lsp` plugins only declare `lspServers` for Claude Code and require the binary on PATH; YandeCode's integration is materialized into the project (ADR-015) and cannot declare `lspServers`. Serena (GPL app, MIT SolidLSP in Python) installs servers on demand.

## Decision

The optional `lsp` module (requires `code`) implements a small JSON-RPC-over-stdio LSP client in TypeScript (initialize, didOpen, definition, references, documentSymbol, publishDiagnostics). Servers are resolved from PATH first, else installed on demand with `npm install --prefix ~/.cache/yandecode/lsp/<server>` (typescript-language-server, pyright). The server is started lazily inside the MCP process on first use and reused for the session. It powers `code_references` (precise mode) and `code_diagnostics(path)`.

## Alternatives considered

- Vendor SolidLSP: Python runtime dependency. Rejected.
- Require users to install the official plugins: breaks "install once". Rejected.

## Consequences

Languages without a configured server fall back to graph/lexical references, and the result states which mode answered.
