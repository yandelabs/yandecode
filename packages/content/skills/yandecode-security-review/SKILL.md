---
name: yandecode-security-review
description: Security-focused review of a change — injection, auth, secrets, unsafe deserialization, SSRF, path traversal, CI workflow injection. Use when a change handles untrusted input, credentials, processes, files, network or CI, or when the user asks for a security review.
---

# Security review

Trace untrusted data from where it enters (HTTP params, CLI args, files, env, webhooks, issue/PR text in CI) to where it is used (shell, SQL, HTML, file paths, URLs fetched, deserializers, `eval`). A finding needs a concrete source → sink path.

## Checklist per sink

- **Shell**: arguments passed as an array (`execFile`, `spawn`, `subprocess.run([...])`), never interpolated into a command string.
- **SQL**: parameters/placeholders only.
- **HTML**: text rendering or a vetted sanitizer; no `innerHTML` / `dangerouslySetInnerHTML` with input.
- **Paths**: resolved and checked to stay inside the intended root (no `..` escape, symlinks considered).
- **URLs fetched server-side**: allowlist host/scheme (SSRF), no internal addresses.
- **Deserialization**: JSON / `yaml.safe_load`; never `pickle`, `yaml.load`, `torch.load` without `weights_only` on untrusted data.
- **Auth**: every new endpoint/handler checks authentication _and_ authorization for the specific resource; tokens compared in constant time; secrets from the environment, never in code or logs.
- **Crypto**: no MD5/SHA-1 for security, no custom crypto, TLS verification on.
- **CI (GitHub Actions)**: event data (`github.event.*.title/body/...`) reaches `run:` only through `env:` and quoted variables; `pull_request_target` never checks out untrusted code with secrets.

## Report

Only findings with a traced path and confidence ≥ 80 (same scale as yandecode-code-review). For each: `path:line`, source → sink, impact, and the fix. Mention anything that needs a human decision (e.g. threat model) separately, as a question.
