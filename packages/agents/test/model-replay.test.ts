import { expect, it, vi } from 'vitest';
import { MethodRunner } from '@camery/methods';
import { RecordingTransport, ReplayTransport } from '@camery/model-modes';
import { journal, protocolProvider, researchRuntime, source } from './model-support.js';
it('loads a disk role and method, records two structured model decisions, and replays without provider fallback', async () => {
  const task = { tenantId: 'synthetic-tenant', taskId: 'synthetic-research-task' }; const provider = protocolProvider();
  const recording = new RecordingTransport(provider.transport, { kind: 'synthetic_contract', source: 'In-process Agent decision protocol fixture. No network, live model inference, human review or billing.', recordedAt: '2026-11-11T06:00:00.000Z' });
  const f = await researchRuntime(recording, task); const saved = journal(task); const method = vi.spyOn(MethodRunner.prototype, 'run');
  try {
    const report = await f.runtime.run(f.pin, source, f.binding, saved.context);
    expect(report).toMatchObject({ state: 'candidate', charged: { tokens: 79, costMicros: 0 }, usageUnknown: true, steps: 3 }); expect((report.output as { chapters: unknown[] }).chapters).toHaveLength(3); expect(method).toHaveBeenCalledOnce(); expect(provider.calls()).toBe(2);
    expect(report.spans.filter(span => span.modelCall).every(span => span.modelCall?.evidence === 'synthetic_replay')).toBe(true);
    expect(await f.runtime.run(f.pin, source, f.binding, saved.context)).toEqual(report); expect(provider.calls()).toBe(2); expect(method).toHaveBeenCalledOnce();
    const cassette = recording.exportCassette(); expect(cassette.entries).toHaveLength(2); await expect(JSON.stringify(cassette, null, 2) + '\n').toMatchFileSnapshot('./fixtures/agent-decisions.synthetic.json');
    const replay = new ReplayTransport(cassette); const restored = await researchRuntime(replay, task);
    expect(await restored.runtime.run(restored.pin, source, restored.binding, journal(task).context)).toEqual(report); replay.assertComplete(); expect(provider.calls()).toBe(2); expect(method).toHaveBeenCalledTimes(2);
  } finally { method.mockRestore(); }
});
