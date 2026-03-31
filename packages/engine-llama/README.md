# Engine Llama

This package owns the `llama.cpp` adapter implementation.

Stage 1 now provides:
- a file-backed `llama.cpp` version registry scaffold under `engines/llama.cpp/`
- install and probe flows that register either a real system binary or the Stage 1 fake worker runtime
- a command builder that resolves a spawnable process plan instead of a PATH placeholder
- a fake worker harness with readiness, log, and shutdown behavior for gateway integration tests

Downstream consumers should start with `createLlamaCppAdapter()` and, for integration tests, `createLlamaCppHarness()`.
