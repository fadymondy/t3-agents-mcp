import { describe, it, expect } from 'vitest';
import { normalizeDetail, normalizeShell } from '../src/v2.js';
import { T3Api, isSettled, type T3Connection } from '../src/t3.js';
const thread = { id: 't', projectId: 'p', title: 'test', modelSelection: { instanceId: 'codex', model: 'test-model' }, runtimeMode: 'approval-required', interactionMode: 'default', branch: null, worktreePath: null, updatedAt: '2026-01-01T00:00:05Z', archivedAt: null };
const run = (id: string, ordinal: number, status = 'completed') => ({ id, ordinal, status, userMessageId: 'u' + ordinal, requestedAt: '2026-01-01T00:00:01Z', startedAt: null, completedAt: status === 'completed' ? '2026-01-01T00:00:02Z' : null });
const msg = (id: string, runId: string, role = 'user') => ({ id, runId, role, text: id, streaming: false, createdAt: '2026-01-01T00:00:01Z' });
const detail = (runs: unknown[], messages: unknown[]) => ({ snapshotSequence: 1, projection: { thread, runs, messages } });
describe('V2 contract normalization', () => {
    it.each(['preparing', 'queued', 'starting', 'running', 'waiting'])('does not report %s as complete', status => {
        const d = normalizeDetail(detail([run('r', 1, status)], [msg('u1', 'r')]));
        expect(d.thread.latestTurn?.state).toBe('running');
        expect(isSettled(d)).toBe(false);
    });
    it.each(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back'])('preserves terminal %s without a stale reply', status => {
        const d = normalizeDetail(detail([run('old', 1), run('new', 2, status)], [msg('a', 'old', 'assistant'), msg('u2', 'new')]));
        expect(d.thread.latestTurn?.assistantMessageId).toBeNull();
        expect(isSettled(d)).toBe(true);
    });
    it('waits on the message-associated run even when a later steering placeholder was cancelled', () => {
        const d = normalizeDetail(detail([run('active', 1, 'running'), run('placeholder', 2, 'cancelled')], [msg('followup', 'active')]), 'followup');
        expect(d.thread.latestTurn?.turnId).toBe('active');
        expect(isSettled(d, { expectedMessageId: 'followup' })).toBe(false);
    });
    it('does not complete a retry with an older unrelated reply', () => {
        const d = normalizeDetail(detail([run('old', 1)], [msg('old-user', 'old'), msg('old-answer', 'old', 'assistant')]));
        expect(isSettled(d, { expectedMessageId: 'new-user' })).toBe(false);
    });
    it('sorts runs by ordinal and correlates only that run assistant', () => {
        const d = normalizeDetail(detail([run('new', 2), run('old', 1)], [msg('answer', 'new', 'assistant'), msg('old', 'old', 'assistant')]));
        expect(d.thread.latestTurn?.assistantMessageId).toBe('answer');
    });
    it('fails closed on new status or truncated history', () => {
        expect(() => normalizeDetail(detail([run('r', 1, 'surprise')], []))).toThrow();
        expect(() => normalizeDetail({ ...detail([], []), hasMoreHistory: true })).toThrow(/incomplete/);
    });
    it('includes archived threads for idempotency lookup', () => {
        const t = { ...thread, status: 'completed', latestRunId: 'r', activeRunId: null };
        const s = normalizeShell({ snapshotSequence: 1, projects: [], threads: [t], archivedThreads: [{ ...t, id: 'archived', archivedAt: '2026-01-01' }] });
        expect(s.threads.map(t => t.id)).toEqual(['t', 'archived']);
    });
});
describe('V2 commands', () => {
    const spec = { commandId: 'c', threadId: 't', messageId: 'u', projectId: 'p', title: 'test', modelSelection: thread.modelSelection, runtimeMode: 'approval-required' as const, interactionMode: 'default' as const, branch: null, worktreePath: null, text: 'hi' };
    function api() { const calls: Array<{
        tag: string;
        payload: any;
    }> = []; const conn = { http: { get: async () => detail([], []) }, rpc: { call: async (tag: string, payload: any) => { calls.push({ tag, payload }); return { sequence: 1 }; }, close() { }, stream: async () => { } } } as unknown as T3Connection; return { a: new T3Api(conn), calls }; }
    it('launches with deterministic IDs via the supported V2 launch RPC', async () => { const { a, calls } = api(); await a.createThreadWithFirstTurn(spec); expect(calls[0].tag).toBe('orchestration.launchThread'); expect(calls[0].payload).toMatchObject({ commandId: 'c', threadId: 't', creationSource: 'mcp', workspaceStrategy: { type: 'root' }, initialMessage: { messageId: 'u', text: 'hi' } }); });
    it('preserves existing worktree selection', async () => { const { a, calls } = api(); await a.createThreadWithFirstTurn({ ...spec, worktreePath: '/scratch', branch: 'test' }); expect(calls[0].payload.workspaceStrategy).toEqual({ type: 'existing_worktree', worktreePath: '/scratch', branch: 'test' }); });
    it('refuses unsupported setup suppression before any mutation', async () => { const { a, calls } = api(); await expect(a.createThreadWithFirstTurn({ ...spec, newWorktree: { projectCwd: '/p', baseBranch: 'main', runSetupScript: false } })).rejects.toThrow(/cannot disable/); expect(calls).toHaveLength(0); });
    it('dispatches followup through message.dispatch with automatic delivery', async () => { const { a, calls } = api(); await a.startTurn(spec); expect(calls.at(-1)?.payload).toMatchObject({ type: 'message.dispatch', messageId: 'u', deliveryIntent: 'auto', dispatchMode: { type: 'start_immediately' } }); });
    it('interrupts only the explicitly targeted run', async () => { const { a, calls } = api(); await a.interruptTurn('cancel', 't', 'r'); expect(calls[0].payload).toEqual({ type: 'run.interrupt', commandId: 'cancel', threadId: 't', runId: 'r' }); expect(() => a.interruptTurn('cancel', 't')).toThrow(/explicit run/); });
});
