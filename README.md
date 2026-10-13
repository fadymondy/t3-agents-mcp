# T3 Agents MCP ? orchestration V2 support

Local **stdio MCP** server that lets **Codex CLI, Claude Code, and other MCP clients** create, read, and continue threads in an existing T3 Code instance.

This is a maintained fork of [gfsaaser24/t3-code-agent-mcp](https://github.com/gfsaaser24/t3-code-agent-mcp), based on commit `4a47996c70c96f83c6e4eb27f106f4cacb38be58`. The original MIT license and attribution are retained. See [NOTICE](NOTICE).

**V2 means T3 Code orchestration protocol V2**, not MCP protocol version 2 or T3 application version 2. This fork uses T3's existing APIs; it does not replace T3 or create a cloud relay.

## Compatibility

- **Windows, macOS, and Linux**: portable Node.js stdio server, with CI covering all three on Node 22 and 24.
- Live T3 communication verified on Windows with Node 24.19 and T3 `0.0.46-nightly.20261006.2752`. macOS/Linux coverage uses automated tests and a local mock server; live desktop sessions on those platforms have not yet been exercised.
- Node **22.12+** required; Node 24 recommended for the tested setup.
- Codex and Claude are discovered from T3's actual provider/model catalog. A provider must already be installed, enabled, and signed in through T3.
- T3 orchestration V1 is **not supported**. Future nightly builds may change contracts; unknown run states fail closed.
- Tested behavior and limitations: [compatibility report](docs/COMPATIBILITY.md).

## Install from GitHub

The same commands work in Windows PowerShell, macOS Terminal, and Linux shells. Install Node.js 22.12+ and Git first, and start your existing T3 Code instance.

```sh
git clone https://github.com/fadymondy/t3-agents-mcp.git
cd t3-agents-mcp
npm ci
npm run build
npm test
npm audit
```

Use `dist/cli.js`. No global installation, new listener, public tunnel, or T3 modification is needed. An npm registry release is not assumed; use this checkout.

## Pair with your existing T3

1. Open **T3 Settings ? Connections ? Create pairing link**.
2. On Windows run the supplied helper and paste the link into its hidden prompt:

```powershell
powershell -NoProfile -File .\scripts\pair.ps1
```

On **macOS or Linux**, use the Bash helper from an interactive terminal (works with macOS's bundled Bash):

```sh
bash scripts/pair.sh
```

Both helpers hide input and send the link over stdin to the package's official pairing exchange. They do not put the secret in process arguments, shell history, or console output. Use only a localhost or explicitly trusted endpoint. For headless use, provide protected input to:

```sh
node dist/cli.js pair --stdin
```

The original `pair <url-or-code>` command remains compatible but puts the input in process arguments. Prefer stdin. Never paste pairing links into public issues or commit credentials.

Credentials retain the upstream location, **`~/.t3-code-agent-mcp/credentials.json`**, so existing pairings continue working. The file contains a bearer token; protect it as a password. POSIX creation uses directory mode 0700 and file mode 0600. On Windows the helper restricts the credential directory ACL to the current user. Existing custom credential locations need their own ACL review.

```powershell
node dist/cli.js status
```

A successful status reports token validity, projects, threads, and harnesses. A successful MCP initialization alone does **not** prove thread APIs work.

## Connect Codex

Substitute your actual absolute paths:

**Windows PowerShell:**

```powershell
codex mcp add t3 --env T3_SERVER_URL=http://127.0.0.1:3773 -- "C:/Program Files/nodejs/node.exe" "E:/Tools/t3-agents-mcp/dist/cli.js"
```

**macOS / Linux** (run from this package's checkout):

```sh
codex mcp add t3 -- "$(command -v node)" "$(pwd)/dist/cli.js"
```

The port above is an example. Discover your endpoint using `status`; do not assume it. Omitting `T3_SERVER_URL` enables runtime-file discovery. Absolute Node paths are recommended because GUI apps may not inherit your shell's PATH or Node version manager setup.

Equivalent TOML:

```toml
[mcp_servers.t3]
command = "C:/Program Files/nodejs/node.exe"
args = ["E:/Tools/t3-agents-mcp/dist/cli.js"]
```

On macOS/Linux, use your actual executable and checkout paths, for example:

```toml
[mcp_servers.t3]
command = "/usr/local/bin/node"
args = ["/absolute/path/to/t3-agents-mcp/dist/cli.js"]
```

Find Node with `command -v node`; Homebrew, system packages and version managers can use different paths. Do not assume `/usr/local/bin/node` exists.

Preserve other MCP entries. New sessions load the configuration; reconnect the MCP client if an existing session still has the old process.

## Connect Claude Code to a project

Run in your project directory:

**Windows PowerShell:**

```powershell
claude mcp add t3 "C:/Program Files/nodejs/node.exe" "E:/Tools/t3-agents-mcp/dist/cli.js" --scope local --transport stdio
claude mcp get t3
```

**macOS / Linux:**

```sh
claude mcp add t3 "$(command -v node)" "/absolute/path/to/t3-agents-mcp/dist/cli.js" --scope local --transport stdio
claude mcp get t3
```

`--scope local` stores a private project entry in your user configuration, without modifying the repository's `.mcp.json`. Use `--scope user` only if you want it available to all projects. Existing running sessions may need MCP reconnection or a new session; do not restart somebody else's work.

## Tools

Every tool except `t3_list_environments` and `t3_get_orchestration_prompt` takes an optional `environment`. Omit it, or pass `local`, for this machine's T3. See [Cross-environment messaging](#cross-environment-messaging).

| Tool | Behavior |
| --- | --- |
| `t3_list_environments` | `local` plus configured remote environments, with reachability and authorization |
| `t3_list_projects` | Registered projects and roots |
| `t3_list_worktrees` | Existing worktrees and branches |
| `t3_list_harnesses` | Available providers/models; `includeUnusable` explains unavailable providers |
| `t3_list_threads` | Recent thread summaries; optional project, title and archive filtering |
| `t3_search_threads` | Full-text search over user and assistant messages in every project |
| `t3_create_thread` | Explicit project, harness, model, optional workspace, first prompt |
| `t3_send_message` | Follow-up to an exact thread ID; `mode` is `auto` (default), `queue`, `steer` or `restart` |
| `t3_get_thread` | State and bounded output of recent messages |
| `t3_wait_for_turn` | Wait with a deadline; reports `timedOut` explicitly |
| `t3_cancel_turn` | Interrupt the identified run; does not target unrelated threads |
| `t3_get_orchestration_prompt` | Read the bundled optional orchestration prompt |

Example creation input:

```json
{
  "project": "YOUR_SCRATCH_PROJECT_ID",
  "harness": "claudeAgent",
  "model": "EXACT_MODEL_FROM_T3_LIST_HARNESSES",
  "title": "Disposable MCP test",
  "prompt": "Return T3-MCP-CONNECTION-OK. Do not use tools or modify files.",
  "runtimeMode": "approval-required",
  "idempotencyKey": "unique-stable-test-creation-key",
  "wait": true,
  "timeoutSeconds": 180
}
```

Store the returned `threadId`. Send a follow-up with a **different stable key** and the same thread ID. Retry the same logical request with its original key. Do not reuse a key for changed instructions. Do not send the follow-up until the first response has completed unless you intentionally want steering.

The upstream default runtime mode remains `full-access`; explicitly request `approval-required` for conservative operation. The MCP itself does not enforce session ownership, owner approvals for business actions, or a thread allowlist. Those belong in your orchestrator and T3 settings.

## Cross-environment messaging

One MCP process can reach several T3 environments, for example a Mac and a Windows desktop on the same Tailscale tailnet. An agent on either machine can list the other's threads, search and read them, send messages, launch threads, and report back.

Remote environments use the same T3 HTTP and WebSocket API, and the same bearer pairing, as the local one, pointed at a configured address. T3's own `/mcp` endpoint is a different thing. It accepts only OAuth sign-ins from MCP clients, over HTTPS or loopback. See [Alternative: T3's built-in MCP URL](#alternative-t3s-built-in-mcp-url).

### 1. Let the other machine reach T3

On each machine that others should reach, open **T3 Settings → Connections** and enable **Network access**. This restarts the desktop app. T3 then listens beyond loopback. Address it by its **tailnet IP** (`tailscale ip -4`), for example `http://100.94.96.85:3773`.

- Tailnet traffic is encrypted by WireGuard, so plain `http://` over a `100.x` address does not cross the internet in the clear.
- Never port-forward T3, and never put it behind Tailscale **Funnel** or any public URL.
- If Windows Firewall prompts, allow T3 on **private** networks only.
- `curl http://<tailnet-ip>:3773/.well-known/t3/environment` from the other machine should return the environment id. This endpoint needs no token.

### 2. Describe the environments

Create `~/.config/t3-agents-mcp/environments.json`. On Windows that is `%USERPROFILE%\.config\t3-agents-mcp\environments.json`. `T3_MCP_ENVIRONMENTS` overrides the path. An example is in [examples/environments.json](examples/environments.json):

```json
{
  "version": 1,
  "environments": [
    {
      "name": "windows",
      "url": "http://100.94.96.85:3773",
      "environmentId": "c40aaa1c-04df-4915-898f-73c3215d23da",
      "auth": { "type": "paired" }
    }
  ]
}
```

- `name` is what agents pass as `environment`. `local` is reserved. The `environmentId` is accepted too.
- `environmentId` is optional but recommended. The address is probed first, and a server answering with another id is refused **before any token is sent**.
- `timeoutMs` (default 8000) bounds the probe and token commands. HTTP reads time out after 30 s, RPC calls after 60 s.
- The file is re-read on every call, so no restart is needed after editing it.
- The file holds **no tokens**. `auth` only says where to find one:

| `auth` | Token source |
| --- | --- |
| `{ "type": "paired" }` (default) | Stored by `pair --environment <name>` in the credential store, keyed by the url |
| `{ "type": "env", "var": "T3_TOKEN_WINDOWS" }` | Environment variable of the MCP process |
| `{ "type": "keychain", "service": "t3-agents-mcp", "account": "windows" }` | macOS Keychain (`security find-generic-password -w`) |
| `{ "type": "command", "command": ["my-vault", "get", "t3-windows"] }` | First stdout line of a command, run without a shell. Use this for any vault CLI. |

Token values never appear in tool output or logs. Errors name the source (`env T3_TOKEN_WINDOWS`), never the value.

### 3. Pair

On the **remote** machine, open **T3 Settings → Connections → Create pairing link**. On the machine running the MCP, paste the link with hidden input:

```sh
bash scripts/pair.sh windows                                      # macOS / Linux
powershell -NoProfile -File .\scripts\pair.ps1 -Environment mac   # Windows
```

You can also run `node dist/cli.js pair --environment windows --stdin`. The code is exchanged at the **configured** url, whatever host the link names, and only after the environment id checks out. Sessions last 30 days. Revoke them under **Settings → Connections** on the remote.

On a headless host, `t3 auth pairing create --ttl 5m` mints a code. Use the `t3` binary that matches the server version: an older CLI can mint codes the newer server rejects.

Check all configured environments:

```sh
node dist/cli.js environments
```

### 4. Use it

```jsonc
// What is reachable?
{ "tool": "t3_list_environments" }
// Find and read a thread on Windows
{ "tool": "t3_list_threads",  "arguments": { "environment": "windows", "titleContains": "Hosbah" } }
{ "tool": "t3_get_thread",    "arguments": { "environment": "windows", "threadId": "<id>", "messageLimit": 2 } }
{ "tool": "t3_search_threads","arguments": { "environment": "windows", "query": "Postiz" } }
// Deliver a brief without interrupting work in progress
{ "tool": "t3_send_message",  "arguments": { "environment": "windows", "threadId": "<id>", "mode": "queue",
                                            "idempotencyKey": "postiz-brief-1", "prompt": "..." } }
```

`mode` follows T3's own `t3_thread_send`:

- `auto` steers a steerable active run, queues behind one that is not, and starts an idle thread.
- `queue` waits for the active run to finish.
- `steer` and `restart` require an active run.

To have a remote thread report back, give it this MCP and a config entry for the caller's machine. It then calls `t3_send_message` with `environment: "mac"`, the caller's thread id and `mode: "queue"`.

Errors say which environment failed and why:

- *unreachable within 8000ms*: T3 is down, network access is off, or Tailscale is disconnected.
- *answered as environment …*: the configured address now belongs to a different server.
- *not paired* or *rejected the stored token (401)*: the error includes the exact `pair --environment` command to run.

### Alternative: T3's built-in MCP URL

Current T3 builds also let an outside agent connect directly to an environment's own MCP server. Use **Settings → Connections → Copy MCP URL**, then run `claude mcp add --transport http t3-windows https://<host>/mcp`. Sign in through the browser with a pairing code, and choose read-only or a runtime-mode ceiling.

This route requires **HTTPS** (Tailscale Serve or T3 Connect) or loopback, because MCP clients refuse OAuth over plain `http://` tailnet addresses. Prefer it when you want per-agent permission ceilings. Prefer this package when you want plain tailnet addresses, idempotent sends, `wait`, and one MCP covering several environments.

## V2 implementation

- HTTP requests use `x-t3-orchestration-protocol: 2`.
- WebSocket connections negotiate `orchestrationProtocol=2`.
- Creation uses `orchestration.launchThread`, with deterministic command/thread/message IDs.
- Follow-ups use `message.dispatch`; interruption uses `run.interrupt`.
- Reads normalize V2 projections, runs, and run-linked messages into the tools' existing response shape. Compatibility `turnId` fields contain **V2 run IDs**.
- Preparing, queued, starting, running, and waiting are nonterminal. Failed, interrupted, cancelled, and rolled-back runs are not mislabeled as success.
- Waiting correlates replies to the requested message's run. It never substitutes an earlier run's assistant reply. Event subscriptions plus bounded refreshes handle projection lag.
- An incomplete history projection is rejected for retry safety.
- `newWorktree` uses V2 workspace preparation. **`runSetupScript:false` is rejected** because this launch API cannot guarantee suppression. Use an existing isolated worktree when setup must not run. Project setup scripts may execute on fresh-worktree creation.

## Environment

| Variable | Purpose |
| --- | --- |
| `T3_SERVER_URL` | Explicit trusted T3 origin |
| `T3CODE_HOME` | T3 runtime discovery directory; default `~/.t3` |
| `T3_ACCESS_TOKEN` | Optional injected token; prefer local pairing for interactive use |
| `T3_MCP_CREDENTIALS` | Optional credential-store path |
| `T3_MCP_ENVIRONMENTS` | Remote environments file; default `~/.config/t3-agents-mcp/environments.json` |

Home paths resolve through Node's `os.homedir()`: typically `C:/Users/<user>` on Windows, `/Users/<user>` on macOS, and `/home/<user>` on Linux. Runtime discovery reads `<home>/.t3/userdata/server-runtime.json` or `<home>/.t3/dev/server-runtime.json`; `T3CODE_HOME` overrides the discovery directory. WSL and containers have separate homes/process namespaces: use their own T3 instance or an explicitly trusted endpoint, rather than assuming Windows auto-discovery applies.

## Validation

```powershell
npm run typecheck
npm test
npm run build
npm audit
```

Unit tests use a fake HTTP/WebSocket server and do not create T3 threads. A separate opt-in smoke test creates one real thread in an **already registered scratch project**:

```powershell
npx tsx test/smoke.live.mts SCRATCH_PROJECT_ID HARNESS EXACT_MODEL STABLE_TEST_KEY
```

The remote-environment path has its own opt-in live test. It is read-only unless you pass `--send`, which queues one message to the thread you name, so use a scratch thread. To exercise the remote path on a single machine, configure an environment that points at your own T3:

```sh
npx tsx test/environments.live.mts ENV_NAME --read THREAD_ID --send SCRATCH_THREAD_ID
```

Never point it at someone else's active session. See [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [CHANGELOG.md](CHANGELOG.md).

## Security and remote orchestration

This package exposes stdio only; it does not open a network listener. Remote environments are reached as a client, at addresses you configure. Its pairing token carries broad T3 client scopes and can reach projects and configured harnesses. Trust every MCP client that receives access. Pairing to an untrusted URL can expose the pairing credential; use loopback or an explicitly trusted host.

ChatGPT cannot directly access a local stdio process. A future remote integration needs an authenticated, owner-approved transport with identity, ownership checks, audit records, and retry safety. No relay, Tailscale changes, or public access are included here.

## Attribution

- Original project: [gfsaaser24/t3-code-agent-mcp](https://github.com/gfsaaser24/t3-code-agent-mcp)
- T3 Code: [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
- MCP TypeScript SDK: [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)

Independent community fork; not an official T3 Code, Anthropic, or OpenAI product. MIT licensed.
