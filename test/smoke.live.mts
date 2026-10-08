/** Opt-in: creates ONE thread in the explicitly selected registered scratch project. */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const [projectId, harness, model, key] = process.argv.slice(2);
if (!projectId || !harness || !model || !key)
    throw new Error('Usage: npx tsx test/smoke.live.mts SCRATCH_PROJECT_ID HARNESS EXACT_MODEL STABLE_TEST_KEY');
const client = new Client({ name: 't3-agents-v2-smoke', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js'], env: process.env as Record<string, string>, stderr: 'pipe' });
async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 55000 });
    const body = (result.content as Array<{
        text: string;
    }>).map(c => c.text).join('');
    if (result.isError)
        throw new Error(name + ': ' + body);
    return JSON.parse(body);
}
async function settled(name: string, args: Record<string, unknown>) {
    for (let attempt = 0; attempt < 6; attempt++) {
        const result = await call(name, { ...args, wait: true, timeoutSeconds: 30 });
        if (!result.timedOut) {
            assert.equal(result.turn?.state, 'completed');
            return result;
        }
    }
    throw new Error('Timed out; keep the same test key to recover this thread.');
}
try {
    await client.connect(transport);
    const projects = await call('t3_list_projects');
    assert(projects.some((p: {
        id: string;
    }) => p.id === projectId), 'Exact project ID not found. No fallback is allowed.');
    const providers = await call('t3_list_harnesses');
    assert(providers.some((p: {
        harnessId: string;
        models: Array<{
            model: string;
        }>;
    }) => p.harnessId === harness && p.models.some(m => m.model === model)), 'Select an available harness and exact model.');
    await call('t3_list_worktrees', { project: projectId });
    const create = { project: projectId, harness, model, title: 'Disposable MCP V2 smoke test', runtimeMode: 'approval-required', prompt: 'Return exactly T3-MCP-CONNECTION-OK. Do not call tools, modify files, or access external services.', idempotencyKey: key };
    const first = await settled('t3_create_thread', create);
    assert.match(first.reply?.text ?? '', /T3-MCP-CONNECTION-OK/);
    const retry = await call('t3_create_thread', create);
    assert.equal(retry.threadId, first.threadId);
    assert.equal(retry.reused, true);
    const follow = { threadId: first.threadId, prompt: 'Return exactly T3-MCP-FOLLOWUP-OK. Do not call tools or modify anything.', idempotencyKey: key + ':followup' };
    const second = await settled('t3_send_message', follow);
    assert.match(second.reply?.text ?? '', /T3-MCP-FOLLOWUP-OK/);
    assert.equal((await call('t3_send_message', follow)).reused, true);
    const read = await call('t3_get_thread', { threadId: first.threadId, messageLimit: 20 });
    assert(read.messages.some((m: {
        role: string;
        text: string;
    }) => m.role === 'assistant' && m.text.includes('T3-MCP-CONNECTION-OK')));
    assert(read.messages.some((m: {
        role: string;
        text: string;
    }) => m.role === 'assistant' && m.text.includes('T3-MCP-FOLLOWUP-OK')));
    assert.equal(read.messages.filter((m: {
        role: string;
    }) => m.role === 'user').length, 2, 'Unexpected duplicate messages');
    console.log('PASS: create, first reply, follow-up, read-back, idempotent retries. Thread:', first.threadId);
}
finally {
    await client.close();
}
