# Engine Core

This package is the engine-facing handoff point for runtime consumers.

Stage 1 now includes:
- file-backed engine version registry helpers
- support-path bootstrapping for engine-owned runtime directories
- command-resolution and health-check interfaces that can back a real child process

Thread 2 can build against these helpers without reaching into `engine-llama` internals.
