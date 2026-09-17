export function nextOfflineActivitySequence(current: number, trustedEvent: boolean) {
  if (!Number.isSafeInteger(current) || current < 0) return 0
  if (!trustedEvent || current === Number.MAX_SAFE_INTEGER) return current
  return current + 1
}
