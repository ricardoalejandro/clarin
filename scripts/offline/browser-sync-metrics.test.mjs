import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncMetrics, isReplayRejection } from '../../infra/offline/qa/sync-metrics.mjs';

test('QA sync metadata stays bounded, copied and resettable without retaining payloads', () => {
  const metrics = createSyncMetrics(2);
  metrics.start().bytes = 1;
  const second = metrics.start();
  second.bytes = Buffer.byteLength('á'.repeat(100_000)); second.status = 200; second.complete = true;
  metrics.start().lost_ack = true;
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0].bytes, 200_000);
  assert.deepEqual(Object.keys(snapshot[0]), ['bytes', 'status', 'lost_ack', 'complete', 'replay_rejected']);
  snapshot[0].bytes = 0;
  assert.equal(metrics.snapshot()[0].bytes, 200_000);
  metrics.reset();
  assert.deepEqual(metrics.snapshot(), []);
});

test('only an exact bounded replay rejection is classified, never arbitrary conflicts', () => {
  assert.equal(isReplayRejection('{"error":"offline_replay_rejected"}'), true);
  for (const raw of ['{"error":"offline_state_conflict"}', '{}', 'invalid', ' '.repeat(4097)]) assert.equal(isReplayRejection(raw), false);
});
