export function whiteboardWriteTransportAvailable(browserOnline: boolean, runtimeOffline: boolean) {
  return browserOnline || runtimeOffline
}

export async function runWhiteboardWrite<T>(input: {
  browserOnline: boolean
  runtimeOffline: boolean
  write: () => Promise<T>
}): Promise<{ attempted: false } | { attempted: true; result: T }> {
  if (!whiteboardWriteTransportAvailable(input.browserOnline, input.runtimeOffline)) return { attempted: false }
  return { attempted: true, result: await input.write() }
}
