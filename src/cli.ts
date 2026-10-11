#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { credentialsPath, exchangePairingCode, parsePairingInput, saveCredential } from "./credentials.js";
import { discoverServer } from "./discovery.js";
import { EnvironmentRegistry, environmentsPath, probeConfigured, toolEnvironments } from "./environments.js";
import { connect, T3Api, type T3Connection } from "./t3.js";
import { registerTools, type ToolContext } from "./tools.js";

const USAGE = `t3-code-agent-mcp <command>

Commands:
  serve            Run the MCP server on stdio (default)
  pair <url|code|--stdin>  Exchange a T3 pairing link or code for a token and store it
  pair --environment <name> <url|code|--stdin>
                   Pair with a remote environment from environments.json
  status           Show the discovered T3 server and whether a token works
  environments     Check every configured remote environment
  help             Show this help

Environment:
  T3_SERVER_URL        Skip discovery and use this origin (e.g. http://127.0.0.1:3773)
  T3CODE_HOME          T3 data dir to look in for server-runtime.json
  T3_ACCESS_TOKEN      Use this bearer token instead of the stored one
  T3_MCP_CREDENTIALS   Where to store tokens (default ~/.t3-code-agent-mcp/credentials.json)
  T3_MCP_ENVIRONMENTS  Remote environments file (default ~/.config/t3-agents-mcp/environments.json)
`;

async function serve(): Promise<void> {
  // The local connection is lazy: with remote environments configured, the
  // server is useful even when this machine's T3 is down or not paired. A
  // failed attempt is retried on the next call.
  let localConn: Promise<T3Connection> | null = null;
  const local = async (): Promise<ToolContext> => {
    localConn ??= connect().then(
      (conn) => {
        process.stderr.write(`t3-agents-mcp: connected to ${conn.server.origin} (token from ${conn.tokenSource})\n`);
        return conn;
      },
      (error) => {
        localConn = null;
        throw error;
      },
    );
    const conn = await localConn;
    return { api: new T3Api(conn), origin: conn.server.origin, environmentId: conn.server.environmentId };
  };
  const registry = new EnvironmentRegistry(environmentsPath());
  const server = new McpServer({ name: "t3-agents-mcp", version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version });
  registerTools(server, local, toolEnvironments(registry));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Connect eagerly so the first call is fast and a problem shows in the log; failure is not fatal.
  void local().catch((error) => process.stderr.write(`t3-agents-mcp: local T3 not available yet: ${error instanceof Error ? error.message : String(error)}\n`));
  const shutdown = () => {
    void localConn?.then((conn) => conn.rpc.close(), () => undefined);
    registry.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  transport.onclose = shutdown;
}

async function pair(args: string[]): Promise<void> {
  let environment: string | undefined;
  const flag = args.indexOf("--environment");
  if (flag !== -1) {
    environment = args[flag + 1];
    if (!environment) throw new Error("Usage: t3-agents-mcp pair --environment <name> <pairing-url-or-code|--stdin>");
    args = args.filter((_, i) => i !== flag && i !== flag + 1);
  }
  let input = args[0];
  if (!input) throw new Error("Usage: t3-code-agent-mcp pair <pairing-url-or-code>");
  if (input === "--stdin") {
    let value = "";
    for await (const chunk of process.stdin) { value += chunk; if (value.length > 16384) throw new Error("Pairing input too long."); }
    input = value.trim();
  }
  const parsed = parsePairingInput(input);
  let origin: string;
  if (environment) {
    // Exchange at the configured address, whatever host the link names, and
    // only after the server there proves it is the configured environment.
    const entry = await new EnvironmentRegistry(environmentsPath()).find(environment);
    origin = (await probeConfigured(entry)).origin;
  } else {
    origin = parsed.origin ?? (await discoverServer()).origin;
  }
  const credential = await exchangePairingCode(origin, parsed.code);
  const path = credentialsPath();
  await saveCredential(path, credential);
  process.stdout.write(`Paired with ${origin}. Token stored in ${path} (expires ${credential.expiresAt}).\n`);
}

async function status(): Promise<void> {
  const server = await discoverServer();
  process.stdout.write(`Server: ${server.origin} (v${server.serverVersion ?? "?"}, ${server.label ?? "unlabeled"}) via ${server.runtimeFile}\n`);
  try {
    const conn = await connect();
    const api = new T3Api(conn);
    const [shell, config] = await Promise.all([api.shell(), api.config()]);
    conn.rpc.close();
    process.stdout.write(`Token: ok (${conn.tokenSource})\n`);
    process.stdout.write(`Projects: ${shell.projects.length}, threads: ${shell.threads.length}, harnesses: ${config.providers.map((p) => p.instanceId).join(", ")}\n`);
  } catch (error) {
    process.stdout.write(`Token: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

async function environments(): Promise<void> {
  const registry = new EnvironmentRegistry(environmentsPath());
  const statuses = await toolEnvironments(registry).statuses(true);
  registry.close();
  if (statuses.length === 0) {
    process.stdout.write(`No remote environments configured in ${registry.path}.\n`);
    return;
  }
  for (const s of statuses) {
    const state = s.authorized ? `ok, ${s.projects} projects, ${s.threads} threads` : s.reachable ? "reachable, not authorized" : "unreachable";
    process.stdout.write(`${s.name}: ${s.url} ${s.label ? `(${s.label}, v${s.serverVersion ?? "?"}) ` : ""}- ${state}\n`);
    if (s.error) process.stdout.write(`  ${s.error}\n`);
  }
  if (statuses.some((s) => !s.authorized)) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command = "serve", ...args] = process.argv.slice(2);
  switch (command) {
    case "serve":
      return serve();
    case "pair":
      return pair(args);
    case "status":
      return status();
    case "environments":
    case "envs":
      return environments();
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
