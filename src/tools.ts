import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { EnvironmentStatus } from "./environments.js";
import { commandIds } from "./ids.js";
import { registerOrchestrationPromptTool } from "./prompts.js";
import { normalizePath, resolveExistingWorktree, resolveHarness, resolveModel, resolveProject, unusableReason } from "./resolve.js";
import { PAIR_HINT } from "./rpc.js";
import type { T3Api } from "./t3.js";
import type { Message, ThreadDetailSnapshot, ThreadShell } from "./types.js";

const RuntimeModeSchema = z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const InteractionModeSchema = z.enum(["default", "plan"]);
const ContextSchema = z.array(z.object({ label: z.string().optional(), text: z.string() })).optional();
const DeliveryModeSchema = z.enum(["auto", "queue", "steer", "restart"]);
const EnvironmentSchema = z
  .string()
  .optional()
  .describe('Target T3 environment by name or environment id (see t3_list_environments). Default "local", this machine.');

export interface ToolContext {
  api: T3Api;
  origin: string;
  environmentId: string;
  /** Name of a configured remote environment; absent for the local one. */
  environment?: string;
}

/** Configured remote environments (see environments.ts). */
export interface Environments {
  resolve(nameOrId: string): Promise<ToolContext>;
  /** The environment id configured for a name or id, if any; never connects. */
  configuredId?(nameOrId: string): Promise<string | undefined>;
  statuses(verify: boolean): Promise<EnvironmentStatus[]>;
  /** Drop a cached connection after a failure so the next call reconnects. */
  evict(nameOrId: string): void;
}

const isLocal = (environment: string | undefined) => !environment || environment.trim().toLowerCase() === "local";

/** Failures that mean the connection itself is bad, as opposed to a bad request. */
const CONNECTION_FAILURE = /WebSocket|rejected the stored token|timed out|fetch failed|ECONN|unreachable|not paired|expired/i;

const composeMessage = (prompt: string, context?: Array<{ label?: string; text: string }>): string => {
  if (!context?.length) return prompt;
  const blocks = context.map((c) => `### ${c.label ?? "Context"}\n\n${c.text}`).join("\n\n");
  return `${prompt}\n\n---\n\n${blocks}`;
};

const summarizeThread = (thread: ThreadShell | ThreadDetailSnapshot["thread"], ctx: ToolContext) => ({
  threadId: thread.id,
  title: thread.title,
  projectId: thread.projectId,
  harness: thread.modelSelection.instanceId,
  model: thread.modelSelection.model,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  turn: thread.latestTurn
    ? {
        turnId: thread.latestTurn.turnId,
        state: thread.latestTurn.state,
        startedAt: thread.latestTurn.startedAt,
        completedAt: thread.latestTurn.completedAt,
      }
    : null,
  session: thread.session ? { status: thread.session.status, lastError: thread.session.lastError } : null,
  archived: thread.archivedAt !== null,
  ...("hasPendingApprovals" in thread
    ? {
        needsAttention: {
          pendingApprovals: thread.hasPendingApprovals,
          pendingUserInput: thread.hasPendingUserInput,
          actionablePlan: thread.hasActionableProposedPlan,
        },
      }
    : {}),
  // Matches the web route `/$environmentId/$threadId`.
  url: `${ctx.origin}/${ctx.environmentId}/${thread.id}`,
  ...(ctx.environment ? { environment: ctx.environment, environmentId: ctx.environmentId } : {}),
});

const renderMessages = (messages: Message[], limit: number, maxChars: number) =>
  messages.slice(-limit).map((m) => ({
    id: m.id,
    role: m.role,
    turnId: m.turnId,
    streaming: m.streaming,
    createdAt: m.createdAt,
    text: m.text.length > maxChars ? `${m.text.slice(0, maxChars)}\n…[truncated ${m.text.length - maxChars} chars]` : m.text,
  }));

const latestAssistantReply = (snapshot: ThreadDetailSnapshot): Message | null => {
  const turn = snapshot.thread.latestTurn;
  if (turn?.assistantMessageId) {
    const byId = snapshot.thread.messages.find((m) => m.id === turn.assistantMessageId);
    if (byId) return byId;
  }
  return turn ? [...snapshot.thread.messages].reverse().find((m) => m.role === "assistant" && m.turnId === turn.turnId) ?? null : null;
};

const turnResult = (snapshot: ThreadDetailSnapshot, ctx: ToolContext, timedOut: boolean) => {
  const reply = latestAssistantReply(snapshot);
  return {
    ...summarizeThread(snapshot.thread, ctx),
    timedOut,
    reply: reply ? { messageId: reply.id, streaming: reply.streaming, text: reply.text } : null,
  };
};

const WAIT_DEFAULT_SECONDS = 300;

/**
 * Register one tool whose handler returns JSON or throws; errors become
 * `isError` results. Errors from a remote environment name it, and point at
 * that environment's pairing command rather than the local one.
 */
function registerTool<Shape extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  meta: { title: string; description: string; inputSchema: Shape },
  run: (input: ShapeOutput<Shape>) => Promise<unknown>,
  environments?: Environments,
): void {
  const callback = async (input: ShapeOutput<Shape>): Promise<CallToolResult> => {
    try {
      const value = await run(input);
      return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      const environment = (input as { environment?: string }).environment;
      if (!isLocal(environment)) {
        if (CONNECTION_FAILURE.test(message)) environments?.evict(environment!);
        message = message.replace(PAIR_HINT, `Re-pair it: t3-agents-mcp pair --environment ${environment} --stdin`);
        if (!message.includes(`"${environment}"`)) message = `[environment "${environment}"] ${message}`;
      }
      return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
  };
  // ToolCallback is a conditional type the compiler cannot narrow for a generic Shape; the shape is exact at every call site.
  server.registerTool(name, meta, callback as unknown as ToolCallback<Shape>);
}

export function registerTools(
  server: McpServer,
  local: ToolContext | (() => Promise<ToolContext>),
  environments?: Environments,
): void {
  const localContext = async (): Promise<ToolContext> => (typeof local === "function" ? local() : local);
  const target = async (environment: string | undefined): Promise<ToolContext> => {
    if (isLocal(environment)) return localContext();
    // An entry (or id) naming this machine itself, e.g. a shared config's
    // "windows" entry read on Windows, goes through the local connection: the
    // tailnet loopback is usually unpaired here and would fail.
    const here = await localContext().catch(() => undefined);
    if (here) {
      const id = here.environmentId.toLowerCase();
      const wanted = environment!.trim().toLowerCase();
      const configured = await environments?.configuredId?.(environment!).catch(() => undefined);
      if (wanted === id || configured?.toLowerCase() === id) return here;
    }
    if (!environments) throw new Error(`Unknown environment "${environment}": no remote environments are configured.`);
    return environments.resolve(environment!);
  };
  const tool = <Shape extends ZodRawShapeCompat>(
    srv: McpServer,
    name: string,
    meta: { title: string; description: string; inputSchema: Shape },
    run: (input: ShapeOutput<Shape>) => Promise<unknown>,
  ) => registerTool(srv, name, meta, run, environments);

  registerOrchestrationPromptTool(server);

  tool(
    server,
    "t3_list_environments",
    {
      title: "List T3 environments",
      description:
        'List the T3 environments this MCP can reach: "local" (this machine) plus every remote one configured in environments.json, e.g. another desktop on the tailnet. Each entry says whether it is reachable and authorized. Pass an entry\'s name as `environment` to any other tool to act there.',
      inputSchema: {
        verify: z.boolean().optional().describe("Also check each token with an authenticated read (default true)"),
      },
    },
    async ({ verify }) => {
      const check = verify ?? true;
      let localStatus: EnvironmentStatus;
      try {
        const ctx = await target(undefined);
        localStatus = { name: "local", url: ctx.origin, local: true, reachable: true, environmentId: ctx.environmentId };
        if (check) {
          const shell = await ctx.api.shell();
          Object.assign(localStatus, { authorized: true, projects: shell.projects.length, threads: shell.threads.length });
        }
      } catch (error) {
        localStatus = { name: "local", url: "", local: true, reachable: false, error: error instanceof Error ? error.message : String(error) };
      }
      const remote = environments ? await environments.statuses(check) : [];
      const localId = localStatus.environmentId?.toLowerCase();
      const marked = await Promise.all(
        remote.map(async (status) => {
          const configured = await environments?.configuredId?.(status.name).catch(() => undefined);
          if (!localId || configured?.toLowerCase() !== localId) return status;
          const { error: _unused, ...rest } = status;
          return { ...rest, ...localStatus, name: status.name, url: status.url, local: true, aliasOf: "local" };
        }),
      );
      return [localStatus, ...marked];
    },
  );

  tool(
    server,
    "t3_search_threads",
    {
      title: "Search threads",
      description:
        "Full-text search over user and assistant messages in every project of an environment. Returns matching threads with their titles and a snippet.",
      inputSchema: {
        environment: EnvironmentSchema,
        query: z.string().min(2).max(200),
        limit: z.number().int().min(1).max(50).optional().describe("Default 20"),
      },
    },
    async ({ environment, query, limit }) => {
      const ctx = await target(environment);
      const [matches, shell] = await Promise.all([ctx.api.searchThreads(query, limit ?? 20), ctx.api.shell()]);
      const byId = new Map(shell.threads.map((t) => [t.id, t]));
      return matches.map((m) => {
        const thread = byId.get(m.threadId);
        return {
          threadId: m.threadId,
          title: thread?.title ?? null,
          projectId: m.projectId,
          source: m.source,
          snippet: m.snippet,
          messageCreatedAt: m.messageCreatedAt,
          ...(thread ? { url: summarizeThread(thread, ctx).url } : {}),
          ...(ctx.environment ? { environment: ctx.environment } : {}),
        };
      });
    },
  );

  tool(
    server,
    "t3_list_projects",
    {
      title: "List T3 projects",
      description: "List the projects the running T3 server knows about, with ids, titles, and workspace roots.",
      inputSchema: { environment: EnvironmentSchema },
    },
    async ({ environment }) => {
      const ctx = await target(environment);
      const { api } = ctx;
      const shell = await api.shell();
      return shell.projects.map((p) => ({
        id: p.id,
        title: p.title,
        workspaceRoot: p.workspaceRoot,
        defaultModelSelection: p.defaultModelSelection,
      }));
    },
  );

  tool(
    server,
    "t3_list_worktrees",
    {
      title: "List worktrees for a project",
      description:
        "List the git worktrees and local branches of a T3 project. The project root is always a valid worktreePath. Pass the project id, exact title, or workspace root.",
      inputSchema: { environment: EnvironmentSchema, project: z.string().describe("Project id, exact title, or workspace root path") },
    },
    async ({ environment, project }) => {
      const ctx = await target(environment);
      const { api } = ctx;
      const shell = await api.shell();
      const resolved = resolveProject(shell.projects, project);
      const refs = await api.listRefs(resolved.workspaceRoot);
      const root = normalizePath(resolved.workspaceRoot);
      const current = refs.refs.find((r) => r.current && !r.isRemote);
      return {
        projectId: resolved.id,
        isRepo: refs.isRepo,
        worktrees: [
          { worktreePath: resolved.workspaceRoot, branch: current?.name ?? null, isProjectRoot: true },
          ...refs.refs
            .filter((r) => r.worktreePath && normalizePath(r.worktreePath) !== root)
            .map((r) => ({ worktreePath: r.worktreePath, branch: r.name, isProjectRoot: false })),
        ],
        branches: refs.refs.filter((r) => !r.isRemote).map((r) => ({ name: r.name, isDefault: r.isDefault, worktreePath: r.worktreePath })),
      };
    },
  );

  tool(
    server,
    "t3_list_harnesses",
    {
      title: "List harnesses and models",
      description:
        "List the coding-agent harnesses configured in T3 (T3 calls them providers; harnessId is the provider instanceId) and the models each one offers. `usable: false` entries carry a `reason` and cannot start threads.",
      inputSchema: { environment: EnvironmentSchema, includeUnusable: z.boolean().optional().describe("Also list harnesses that cannot start threads right now") },
    },
    async ({ environment, includeUnusable }) => {
      const ctx = await target(environment);
      const { api } = ctx;
      const config = await api.config();
      return config.providers
        .map((p) => ({ provider: p, reason: unusableReason(p) }))
        .filter(({ reason }) => includeUnusable || reason === null)
        .map(({ provider: p, reason }) => ({
          harnessId: p.instanceId,
          driver: p.driver,
          displayName: p.displayName ?? p.instanceId,
          usable: reason === null,
          reason: reason ?? undefined,
          status: p.status,
          auth: p.auth.status,
          version: p.version,
          models: p.models.map((m) => ({
            model: m.slug,
            name: m.name,
            aliases: m.aliases,
            isDefault: m.isDefault ?? false,
            isLegacy: m.isLegacy ?? false,
          })),
        }));
    },
  );

  tool(
    server,
    "t3_list_threads",
    {
      title: "List threads",
      description: "List recent T3 threads, newest first, on this machine or a remote environment. Optionally filter by project or title.",
      inputSchema: {
        environment: EnvironmentSchema,
        project: z.string().optional().describe("Project id, exact title, or workspace root path"),
        titleContains: z.string().optional().describe("Case-insensitive title filter"),
        includeArchived: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 25"),
      },
    },
    async ({ environment, project, titleContains, includeArchived, limit }) => {
      const ctx = await target(environment);
      const { api } = ctx;
      const shell = await api.shell();
      const projectId = project ? resolveProject(shell.projects, project).id : undefined;
      return shell.threads
        .filter((t) => (projectId ? t.projectId === projectId : true))
        .filter((t) => includeArchived || t.archivedAt === null)
        .filter((t) => !titleContains || t.title.toLowerCase().includes(titleContains.toLowerCase()))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit ?? 25)
        .map((t) => summarizeThread(t, ctx));
    },
  );

  tool(
    server,
    "t3_create_thread",
    {
      title: "Create a T3 thread and send the first prompt",
      description:
        "Create a new thread in T3 with an explicit project, worktree, harness, and model, then send the first prompt. The thread appears in the T3 UI. Nothing is substituted: unknown or unusable choices fail with the valid options. Pass the same idempotencyKey on retries to guarantee a single launch; a key whose command T3 rejected is burned and needs a new key.",
      inputSchema: {
        environment: EnvironmentSchema,
        project: z.string().describe("Project id, exact title, or workspace root (see t3_list_projects)"),
        harness: z.string().describe("Harness id exactly as listed by t3_list_harnesses, e.g. claudeAgent, codex, cursor"),
        model: z.string().describe("Model slug or alias exactly as listed for that harness"),
        title: z.string().min(1).describe("Thread title shown in T3"),
        prompt: z.string().min(1).describe("First user message"),
        context: ContextSchema.describe("Extra context blocks appended below the prompt"),
        worktreePath: z
          .string()
          .optional()
          .describe("Existing worktree path from t3_list_worktrees, or the project root. Default: project root."),
        newWorktree: z
          .object({
            baseBranch: z.string().describe("Branch to start from"),
            branch: z.string().optional().describe("Name for the new branch; T3 generates one when omitted"),
            runSetupScript: z.boolean().optional().describe("Run the project setup script after creating the worktree (default true)"),
          })
          .optional()
          .describe("Ask T3 to create a fresh worktree for this thread. Mutually exclusive with worktreePath."),
        runtimeMode: RuntimeModeSchema.optional().describe("Default full-access"),
        interactionMode: InteractionModeSchema.optional().describe("Default 'default'; 'plan' asks for a plan first"),
        idempotencyKey: z.string().optional().describe("Stable key; retries with the same key reuse the same thread instead of launching again"),
        wait: z.boolean().optional().describe("Wait for the first turn to finish and return the reply (default false)"),
        timeoutSeconds: z.number().int().min(1).max(3600).optional().describe("Max wait when wait=true (default 300)"),
      },
    },
    async (input) => {
      const ctx = await target(input.environment);
      const { api } = ctx;
      if (input.worktreePath && input.newWorktree) throw new Error("Pass either worktreePath or newWorktree, not both.");
      const [shell, config] = await Promise.all([api.shell(), api.config()]);
      const project = resolveProject(shell.projects, input.project);
      const harness = resolveHarness(config.providers, input.harness);
      const model = resolveModel(harness, input.model);
      const ids = commandIds("launch", input.idempotencyKey);
      const runtimeMode = input.runtimeMode ?? "full-access";
      const interactionMode = input.interactionMode ?? "default";
      const text = composeMessage(input.prompt, input.context);

      const existing = shell.threads.find((t) => t.id === ids.threadId);
      if (existing) {
        // T3's bootstrap is a chain (create thread, then start the turn). If it
        // broke between the two, the thread exists with no turn: finish the
        // launch with the same command id rather than reporting a reuse.
        if (!existing.latestTurn) {
          await api.createThreadWithFirstTurn({ ...ids, text, projectId: existing.projectId, title: existing.title, modelSelection: existing.modelSelection, branch: existing.branch, worktreePath: existing.worktreePath, runtimeMode: existing.runtimeMode, interactionMode: existing.interactionMode });
        }
      } else {
        const refs = await api.listRefs(project.workspaceRoot);
        let branch: string | null = null;
        let worktreePath: string | null = null;
        let newWorktree: { projectCwd: string; baseBranch: string; branch?: string; runSetupScript: boolean } | undefined;
        if (input.newWorktree) {
          const base = refs.refs.find((r) => !r.isRemote && r.name === input.newWorktree!.baseBranch);
          if (!base) {
            throw new Error(
              `baseBranch "${input.newWorktree.baseBranch}" is not a local branch of ${project.title}. Known: ${refs.refs
                .filter((r) => !r.isRemote)
                .map((r) => r.name)
                .join(", ")}`,
            );
          }
          branch = input.newWorktree.branch ?? null;
          newWorktree = {
            projectCwd: project.workspaceRoot,
            baseBranch: base.name,
            ...(input.newWorktree.branch ? { branch: input.newWorktree.branch } : {}),
            runSetupScript: input.newWorktree.runSetupScript ?? true,
          };
        } else {
          const choice = resolveExistingWorktree(project, refs.refs, input.worktreePath ?? project.workspaceRoot);
          branch = choice.branch;
          worktreePath = choice.worktreePath;
        }
        await api.createThreadWithFirstTurn({
          ...ids,
          projectId: project.id,
          title: input.title,
          modelSelection: { instanceId: harness.instanceId, model: model.slug },
          runtimeMode,
          interactionMode,
          branch,
          worktreePath,
          text,
          newWorktree,
        });
      }

      const base = { reused: existing !== undefined, idempotencyKey: ids.idempotencyKey };
      if (input.wait) {
        const { snapshot, timedOut } = await api.waitForTurnSettled(ids.threadId, (input.timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000, {
          expectedMessageId: ids.messageId,
        });
        return { ...base, ...turnResult(snapshot, ctx, timedOut) };
      }
      return { ...base, ...summarizeThread((await api.thread(ids.threadId, 1)).thread, ctx) };
    },
  );

  tool(
    server,
    "t3_send_message",
    {
      title: "Send a follow-up prompt",
      description:
        "Send another user message to an existing T3 thread with the thread's current harness and model (or `model` for this one turn), on this machine or a remote environment. `mode` picks delivery while a run is active, like T3's own t3_thread_send: auto steers a steerable run, otherwise queues; queue waits for the active run to finish; steer and restart need an active run. An idle thread starts a new turn in every mode except steer/restart. A retry with the same idempotencyKey is always safe.",
      inputSchema: {
        environment: EnvironmentSchema,
        threadId: z.string(),
        prompt: z.string().min(1),
        context: ContextSchema,
        mode: DeliveryModeSchema.optional().describe("auto (default), queue, steer, or restart"),
        runtimeMode: RuntimeModeSchema.optional().describe("Default: the thread's current mode"),
        interactionMode: InteractionModeSchema.optional().describe("Default: the thread's current mode"),
        idempotencyKey: z.string().optional().describe("Stable key; retries with the same key do not start a second turn"),
        wait: z.boolean().optional().describe("Wait for the turn to finish and return the reply (default false)"),
        timeoutSeconds: z.number().int().min(1).max(3600).optional().describe("Max wait when wait=true (default 300)"),
        model: z.string().min(1).optional().describe("Model slug for this turn only (see t3_list_harnesses); default: the thread's model"),
        harness: z.string().min(1).optional().describe("With model: the harness (provider instanceId). Must be the thread's own; default it"),
        modelOptions: z.record(z.string(), z.unknown()).optional().describe("With model: option values (effort, fastMode…); default none"),
      },
    },
    async (input) => {
      const ctx = await target(input.environment);
      const { api } = ctx;
      const before = await api.thread(input.threadId);
      const current = before.thread.modelSelection;
      if ((input.harness || input.modelOptions) && !input.model) throw new Error("harness and modelOptions need model.");
      // T3 locks a thread to its provider: a per-turn model stays on the thread's harness.
      if (input.harness && current && input.harness !== current.instanceId) {
        throw new Error(`Thread ${input.threadId} runs on ${current.instanceId}; a per-turn model must use the same harness (got ${input.harness}).`);
      }
      const modelSelection = input.model
        ? { instanceId: input.harness ?? current.instanceId, model: input.model, ...(input.modelOptions ? { options: input.modelOptions } : {}) }
        : undefined;
      const ids = commandIds(input.threadId, input.idempotencyKey);
      const alreadySent = before.thread.messages.some((m) => m.id === ids.messageId);
      // No "turn is running" guard on purpose: T3 accepts thread.turn.start
      // mid-turn and forwards it to the harness as steering, same as the UI.
      if (!alreadySent) {
        // Safe even if the message landed after our read: T3 replays the
        // accepted receipt for a repeated commandId instead of starting again.
        await api.startTurn({
          ...ids,
          threadId: input.threadId,
          text: composeMessage(input.prompt, input.context),
          runtimeMode: input.runtimeMode ?? before.thread.runtimeMode,
          interactionMode: input.interactionMode ?? before.thread.interactionMode,
          mode: input.mode ?? "auto",
          modelSelection,
        });
      }
      const base = { reused: alreadySent, idempotencyKey: ids.idempotencyKey };
      if (input.wait) {
        const { snapshot, timedOut } = await api.waitForTurnSettled(input.threadId, (input.timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000, {
          expectedMessageId: ids.messageId,
        });
        return { ...base, ...turnResult(snapshot, ctx, timedOut) };
      }
      return { ...base, ...summarizeThread((await api.thread(input.threadId, 1)).thread, ctx) };
    },
  );

  tool(
    server,
    "t3_get_thread",
    {
      title: "Read a thread",
      description: "Read a thread's status, latest turn state, and recent messages (assistant replies included).",
      inputSchema: {
        environment: EnvironmentSchema,
        threadId: z.string(),
        messageLimit: z.number().int().min(1).max(200).optional().describe("Default 10"),
        maxChars: z.number().int().min(100).max(200_000).optional().describe("Truncate each message to this many characters (default 20000)"),
      },
    },
    async ({ environment, threadId, messageLimit, maxChars }) => {
      const ctx = await target(environment);
      const { api } = ctx;
      const limit = messageLimit ?? 10;
      // Each turn holds at least a user + assistant message, so this window covers `limit` messages.
      const snapshot = await api.thread(threadId, Math.ceil(limit / 2) + 1);
      return {
        ...summarizeThread(snapshot.thread, ctx),
        messages: renderMessages(snapshot.thread.messages, limit, maxChars ?? 20_000),
      };
    },
  );

  tool(
    server,
    "t3_wait_for_turn",
    {
      title: "Wait for the current turn",
      description:
        "Block until the thread's latest turn finishes (or the timeout passes) and return the assistant reply. Prefer wait=true on t3_create_thread / t3_send_message, which know exactly which turn to wait for.",
      inputSchema: {
        environment: EnvironmentSchema,
        threadId: z.string(),
        timeoutSeconds: z.number().int().min(1).max(3600).optional().describe("Default 300"),
      },
    },
    async ({ environment, threadId, timeoutSeconds }) => {
      const ctx = await target(environment);
      const { api } = ctx;
      const { snapshot, timedOut } = await api.waitForTurnSettled(threadId, (timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000);
      return turnResult(snapshot, ctx, timedOut);
    },
  );

  tool(
    server,
    "t3_cancel_turn",
    {
      title: "Cancel the running turn",
      description: "Interrupt the thread's running turn. No-op with a clear message if nothing is running.",
      inputSchema: { environment: EnvironmentSchema, threadId: z.string() },
    },
    async ({ environment, threadId }) => {
      const ctx = await target(environment);
      const { api } = ctx;
      const before = await api.thread(threadId, 1);
      const turn = before.thread.latestTurn;
      if (!turn || turn.state !== "running") {
        return { cancelled: false, reason: "No turn is running.", ...summarizeThread(before.thread, ctx) };
      }
      await api.interruptTurn(randomUUID(), threadId, turn.turnId);
      const { snapshot } = await api.waitForTurnSettled(threadId, 15_000);
      return { cancelled: true, ...summarizeThread(snapshot.thread, ctx) };
    },
  );
}
