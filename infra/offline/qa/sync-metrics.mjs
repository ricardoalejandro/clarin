// Metadata only, bounded, and used exclusively by the disposable QA gateway.
// Never retain bodies, operation IDs, headers, cookies or credentials.
export function createSyncMetrics(limit = 128) {
  const entries = [];
  return {
    start() {
      const entry = { bytes: 0, status: null, lost_ack: false, complete: false, replay_rejected: false };
      entries.push(entry);
      if (entries.length > limit) entries.shift();
      return entry;
    },
    snapshot() { return entries.map(entry => ({ ...entry })); },
    reset() { entries.length = 0; },
  };
}

export function isReplayRejection(raw) {
  if (Buffer.byteLength(raw) > 4096) return false;
  try { return JSON.parse(raw).error === 'offline_replay_rejected'; } catch { return false; }
}
