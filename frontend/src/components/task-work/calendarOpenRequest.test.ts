import { describe, expect, it, vi } from 'vitest'
import type { WorkEventOccurrence } from '@/types/task'
import {
  calendarOpenContextKey,
  calendarOpenRequestForContext,
  consumeCalendarOpenRequest,
  createCalendarOpenRequest,
  type CalendarOpenContext,
} from './calendarOpenRequest'

const context: CalendarOpenContext = {
  accountID: 'account-a', userID: 'user-a', environmentID: 'environment-a',
  scope: { type: 'list', id: 'list-a' },
}
const contextKey = calendarOpenContextKey(context)

describe('calendar open requests', () => {
  it('keeps an explicit request available for the initial calendar mount', () => {
    const request = createCalendarOpenRequest(contextKey, { kind: 'create' }, 'create-1')
    expect(calendarOpenRequestForContext(request, contextKey)).toBe(request)
  })

  it('consumes creation once so navigating back cannot replay it', () => {
    const request = createCalendarOpenRequest(contextKey, { kind: 'create' }, 'create-1')
    const consumed = consumeCalendarOpenRequest(request, request.id)
    expect(calendarOpenRequestForContext(consumed, contextKey)).toBeNull()
    expect(consumeCalendarOpenRequest(consumed, request.id)).toBeNull()
  })

  it('does not let a repeated or late acknowledgement erase the next explicit request', () => {
    const next = createCalendarOpenRequest(contextKey, { kind: 'create' }, 'create-2')
    expect(consumeCalendarOpenRequest(next, 'create-1')).toBe(next)
    expect(calendarOpenRequestForContext(next, contextKey)).toBe(next)
    expect(consumeCalendarOpenRequest(next, next.id)).toBeNull()
  })

  it('gives repeated explicit actions different IDs', () => {
    const randomID = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002')
    const first = createCalendarOpenRequest(contextKey, { kind: 'create' })
    const second = createCalendarOpenRequest(contextKey, { kind: 'create' })
    expect(first.id).not.toBe(second.id)
    expect(randomID).toHaveBeenCalledTimes(2)
  })

  it.each([
    { accountID: 'account-b' },
    { userID: 'user-b' },
    { environmentID: 'environment-b' },
    { scope: { type: 'list', id: 'list-b' } },
    { scope: { type: 'folder', id: 'list-a' } },
    { scope: { type: 'environment', id: 'environment-a' } },
    { scope: { type: 'shared' } },
    { scope: { type: 'archive' } },
    { scope: { type: 'trash' } },
  ] as Partial<CalendarOpenContext>[])('rejects a request after its owning context changes: %j', change => {
    const request = createCalendarOpenRequest(contextKey, { kind: 'create' }, 'create-1')
    expect(calendarOpenRequestForContext(request, calendarOpenContextKey({ ...context, ...change }))).toBeNull()
  })

  it('invalidates a request durably instead of replaying it after returning to its old scope', () => {
    const request = createCalendarOpenRequest(contextKey, { kind: 'create' }, 'create-1')
    const otherContext = calendarOpenContextKey({ ...context, scope: { type: 'list', id: 'list-b' } })
    const invalidated = calendarOpenRequestForContext(request, otherContext)
    expect(calendarOpenRequestForContext(invalidated, contextKey)).toBeNull()
  })

  it('targets the destination scope when opening an explicit shared event', () => {
    const occurrence = { occurrence_key: 'event-1:2026-11-02', event: { id: 'event-1' } } as WorkEventOccurrence
    const destinationKey = calendarOpenContextKey({ ...context, scope: { type: 'environment', id: context.environmentID } })
    const request = createCalendarOpenRequest(destinationKey, { kind: 'focus', occurrence }, 'focus-1')
    expect(calendarOpenRequestForContext(request, destinationKey)).toEqual({
      id: 'focus-1', contextKey: destinationKey, kind: 'focus', occurrence,
    })
    expect(calendarOpenRequestForContext(request, calendarOpenContextKey({ ...context, scope: { type: 'shared' } }))).toBeNull()
    expect(consumeCalendarOpenRequest(request, request.id)).toBeNull()
  })

  it('does not infer opening from an absent request', () => {
    expect(calendarOpenRequestForContext(null, contextKey)).toBeNull()
    expect(calendarOpenRequestForContext(undefined, contextKey)).toBeNull()
  })

  it('keeps context keys unambiguous even if identifiers contain separators', () => {
    expect(calendarOpenContextKey({ ...context, accountID: 'a:b', userID: 'c' }))
      .not.toBe(calendarOpenContextKey({ ...context, accountID: 'a', userID: 'b:c' }))
  })
})
