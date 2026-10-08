# T3 orchestration V2 compatibility and verification

## Verified environment (2026-10-08)

- Windows, Node 24.19.0; Codex CLI 0.160.1; Claude Code 2.1.292.
- T3 server 0.0.46-nightly.20261006.2752, native desktop installation.
- Local stdio MCP client, official T3 pairing, authenticated loopback HTTP and WebSocket connections.
- Available Codex, Claude and OpenCode catalogs read from the server. Actual agent turns tested with Claude Sonnet 5.5; this is not a claim that every listed model was exercised.

## Results

- Build, typecheck and 80 automated regression tests passed at initial V2 validation.
- All 10 MCP tools registered; project, worktree, provider and thread reads succeeded.
- One isolated scratch project and one disposable thread were used.
- Creation returned a durable T3 thread ID. A first marker and a later follow-up marker were returned from the same thread and read back.
- Retrying creation and follow-up with original keys returned reused=true with no extra thread/turn.
- Follow-up while active was delivered as steering. A separate sequential two-turn exchange completed successfully.
- A disposable extra run was interrupted successfully; an unrelated session was never targeted.
- Independent client processes were used for successive calls, exercising MCP process restart/reconnection and persisted pairing.
- The scratch Git worktree remained clean.
- npm audit reported zero known vulnerabilities at verification time.

The first cold Claude startup took about 70 seconds while its existing MCP connections initialized. A 40-second wait correctly reported timedOut, not success. Some unrelated preconfigured Claude connectors required authorization or timed out; this package neither changes nor depends on those connectors.

## Not verified / limits

- Five simultaneously active agents were not launched or load-tested.
- T3 was not restarted because existing user sessions must not be disrupted. Durable state remains owned by T3; clients should reconnect, re-read state and retry with original idempotency keys after a restart. No exactly-once claim across arbitrary future server behavior is made.
- Fresh worktree creation uses the documented V2 workspace strategy and is unit-tested; live testing used an existing scratch root. Setup suppression is not supported by this launch contract and is rejected.
- CI covers Windows/Linux and Node 22/24; a configured CI matrix is not evidence of green runs until GitHub executes it.
- Credentials expire or can be revoked. Re-pair through T3 if authentication fails. The MCP process does not automatically refresh a revoked token.
- Waiting has a deadline. A timed-out request must not be treated as completed or retried with a new key.
- Full projections are currently read for reliable idempotency checks. Very large histories can cost more bandwidth/memory. Bounded/incomplete history is rejected rather than silently missing an earlier request.
- Arbitrary future T3 builds and all providers/models are not certified.

## Contract reference

The installed T3 application's published/bundled contract definitions were inspected read-only: OrchestrationProtocolHeaders, OrchestrationV2ThreadLaunchInput, OrchestrationV2Command, OrchestrationV2ThreadDetailSnapshot, OrchestrationV2Run and OrchestrationV2ConversationMessage. No T3 source or database was modified. Public upstream reference: https://github.com/pingdotgg/t3code.

V2 adds a required HTTP header and WebSocket query parameter, returns projection-based thread detail, and uses launchThread/message.dispatch/run.interrupt. Adding only the protocol header to the original client is insufficient.
