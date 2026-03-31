# Shared Contracts

Thread 3 Stage 0 freezes the engine and artifact contracts in this package so runtime and UI layers can build against stable metadata before real process management exists.

Exports:
- engine adapter types
- capability shapes
- GGUF and model artifact types
- provider search/download contract types
- local artifact layout specification

Sample payloads for contract tests live in `./fixtures`.
