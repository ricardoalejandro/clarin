import { beforeEach, describe, expect, it } from 'vitest'
import { clearEntryIdentityV4, readEntryIdentityV4, storeEntryIdentityV4 } from './entryIdentity'
const identity = { user_id: '11111111-1111-4111-8111-111111111111', account_id: '22222222-2222-4222-8222-222222222222' }
beforeEach(() => sessionStorage.clear())
describe('offline entry exact identity', () => {
  it('stores only the bounded identity and rejects expired or future expectations', () => {
    storeEntryIdentityV4(sessionStorage, identity, 1_000_000)
    expect(readEntryIdentityV4(sessionStorage, 1_000_001)).toEqual(identity)
    expect(readEntryIdentityV4(sessionStorage, 1_600_001)).toBeNull()
    storeEntryIdentityV4(sessionStorage, identity, 1_000_000)
    expect(readEntryIdentityV4(sessionStorage, 999_999)).toBeNull()
  })
  it('only explicit identity change clears the current entry expectation', () => {
    storeEntryIdentityV4(sessionStorage, identity)
    clearEntryIdentityV4(sessionStorage)
    expect(readEntryIdentityV4(sessionStorage)).toBeNull()
    expect(() => storeEntryIdentityV4(sessionStorage, { ...identity, account_id: 'another' })).toThrow()
  })
})
