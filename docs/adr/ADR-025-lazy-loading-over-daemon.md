# ADR-025: Lazy loading instead of a warm daemon; drop USearch and default embeddings

Status: accepted (2026-09-26)

## Context

Hooks cost ~350 ms because every command and dependency is imported eagerly (G1). jev-kit uses a warm daemon to cut network latency; our latency is local import cost. USearch crashes with unbounded recursion when imported outside its expected layout (G2), and embeddings require a Hugging Face download (G9).

## Decision

- `bin.ts` dispatches on `argv` and dynamically imports only the command being run; module runtimes are imported only when one of their hooks/tools runs. Target: hook p50 < 120 ms.
- No daemon in v2. If a measured hook exceeds its budget after lazy loading, revisit.
- USearch is removed. Code search needs no vectors (ADR-017). Knowledge search is BM25 only.

## Consequences

Minimal install has no native vector dependency and no network step. ADR-005/006/007/008/009 are superseded for code, and ADR-005 stays valid only for opt-in semantic knowledge search.

## Amendment (2026-09-26, after benchmarks)

The originally planned opt-in semantic search for knowledge (Arctic embeddings) is **deferred, not implemented**. Measured on `benchmarks/run.ts`: lexical memory recall@3 is 0.8 on a set of 55 memories with distractors; the one miss ("large upload handling" vs a memory saying "above 20 MB go directly to S3") is a vocabulary mismatch only embeddings would fix. Adding `@huggingface/transformers` back would restore the ~400 MB RSS and the model download this ADR removed, for one class of query. Revisit if recall@3 on real projects drops below 0.8; the memory skill asks agents to write titles in the words people will search with.
