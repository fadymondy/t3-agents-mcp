# Changelog

## Unreleased

- Add macOS to the Node 22/24 CI matrix alongside Windows and Linux.
- Add a hidden-input Bash pairing helper for macOS/Linux, shipped with the package and stored with LF line endings.
- Add cross-platform CLI pairing coverage, including paths with spaces, secret redaction and POSIX credential permissions.
- Document installation, Codex/Claude configuration, home directory discovery and validation limits on all three platforms.

## 0.3.0 ? T3 orchestration V2 support

- Forked from gfsaaser24/t3-code-agent-mcp at 4a47996.
- Negotiate protocol V2 for HTTP and WebSocket RPC.
- Use V2 launch, message dispatch and run interruption contracts.
- Normalize projections and correlate replies to the correct run, including steering.
- Keep pending/queued/waiting runs nonterminal and reject incomplete history.
- Add V2 regression coverage and explicit scratch-only live smoke testing.
- Add hidden-input Windows pairing helper and pair --stdin.
- Update dependencies; Vitest 5; zero npm audit findings at verification time.
- Keep the original credential location and legacy executable alias for existing users.

No npm release or Git tag is implied by this source version.
