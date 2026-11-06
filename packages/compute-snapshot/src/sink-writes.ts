export type SinkWrites = Record<string, 'replace' | 'upsert'>;

export function validateSinkWrites(sinks: readonly string[], writes: SinkWrites | undefined): void {
  if (writes === undefined) return;
  if (writes === null || typeof writes !== 'object' || Array.isArray(writes)) {
    throw new Error('sinkWrites must be a sink-to-mode map');
  }
  for (const [sink, mode] of Object.entries(writes)) {
    if (!sinks.includes(sink) || mode !== 'replace' && mode !== 'upsert') {
      throw new Error(`invalid sink write mode for ${sink}`);
    }
  }
}
