import { describe, expect, it, vi } from 'vitest'
import { navigateAfterOnlineLogin } from './onlineLoginNavigation'
import { WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_PATH } from './whiteboardPublicLibraries'

describe('online login document boundary', () => {
  it.each([null, '', '/dashboard/chats', '//example.invalid', 'https://example.invalid', 'javascript:alert(1)'])(
    'opens a fresh dashboard document for non-allowlisted next=%s', next => {
      const target = { assign: vi.fn() }
      navigateAfterOnlineLogin(next, target)
      expect(target.assign).toHaveBeenCalledExactlyOnceWith('/dashboard')
    },
  )

  it.each([
    WHITEBOARD_PUBLIC_LIBRARY_CALLBACK_PATH,
    '/oauth/authorize?client_id=qa&state=fixture',
    'https://clarin.naperu.cloud/oauth/authorize?client_id=qa&state=fixture',
  ])('preserves the existing allowlisted return destination %s in a new document', next => {
    const target = { assign: vi.fn() }
    navigateAfterOnlineLogin(next, target)
    expect(target.assign).toHaveBeenCalledExactlyOnceWith(next)
  })
})
