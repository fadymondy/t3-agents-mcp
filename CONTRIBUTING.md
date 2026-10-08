# Contributing

Read README.md and docs/COMPATIBILITY.md first. Keep changes grounded in T3's actual versioned contracts. Add regression tests for changed wire shapes, run status, retries and errors.

Run npm ci, npm run typecheck, npm test, npm run build and npm audit. Tests must not require credentials or touch real sessions. Live testing is opt-in against a disposable registered project with an explicit harness, model and stable idempotency key.

Never commit secrets, credentials, local session histories or generated dist/node_modules. Preserve upstream MIT attribution. Describe verified T3 versions and untested behavior honestly. Open a focused PR with the change and verification evidence.
