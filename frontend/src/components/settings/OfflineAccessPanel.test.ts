import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OfflineAccessPanel, { completeApprovedOfflineEnrollment, installerFilenameFromDisposition, maxOfflineResources, offlineInstallerDownloadURL, removeResolvedOfflineConflict, sha256Hex, toggleOfflineSelection, type OfflineSelection } from './OfflineAccessPanel'

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

describe('toggleOfflineSelection', () => {
  const existing: OfflineSelection[] = [{ module: 'contacts', resource_type: 'contact', resource_id: 'contact-1', label: 'Ana' }]

  it('adds only the server-provided closed resource type', () => {
    expect(toggleOfflineSelection(existing, 'tasks', { id: 'list-1', type: 'task_list', label: 'Pendientes' })).toEqual([
      ...existing,
      { module: 'tasks', resource_type: 'task_list', resource_id: 'list-1', label: 'Pendientes' },
    ])
  })

  it('removes a selected resource without touching another module', () => {
    expect(toggleOfflineSelection(existing, 'contacts', { id: 'contact-1', type: 'contact', label: 'Ana' })).toEqual([])
  })

	it('enforces the fixed 20-resource pilot limit while still allowing removal', () => {
		const full = Array.from({ length: maxOfflineResources }, (_, index) => ({ module: 'contacts', resource_type: 'contact', resource_id: `contact-${index}` }))
		expect(toggleOfflineSelection(full, 'contacts', { id: 'contact-new', type: 'contact', label: 'Nueva' })).toBe(full)
		expect(toggleOfflineSelection(full, 'contacts', { id: 'contact-0', type: 'contact', label: 'Primera' })).toHaveLength(maxOfflineResources - 1)
	})
})

describe('removeResolvedOfflineConflict', () => {
	it('removes only the conflict acknowledged with the canonical server value', () => {
		expect(removeResolvedOfflineConflict([
			{ id: 'one', module: 'tasks', resource_id: 'task-1', conflict_paths: ['title'], created_at: '2026-09-12T00:00:00Z' },
			{ id: 'two', module: 'programs', resource_id: 'program-1', conflict_paths: ['attendance.status'], created_at: '2026-09-12T00:00:00Z' },
		], 'one').map((item) => item.id)).toEqual(['two'])
	})
})

describe('offline installer verification', () => {
	it('accepts only the safe attachment filename and has a deterministic SHA-256', async () => {
		expect(installerFilenameFromDisposition('attachment; filename="Clarin-Offline-Setup.exe"', 'fallback.exe')).toBe('Clarin-Offline-Setup.exe')
		expect(installerFilenameFromDisposition('attachment; filename="../escape.exe"', 'fallback.exe')).toBe('fallback.exe')
		const blob = { arrayBuffer: async () => new TextEncoder().encode('clarin').buffer } as Blob
		expect(await sha256Hex(blob)).toBe('2f8f33ceb50fe321a845bc9d982f2af5aebbf7f863dfa9da9ad7334ec518a610')
	})

	it('uses the immutable checksum as the installer cache key', () => {
		const checksum = 'C1DB009B123942BA11FE4127D76E52213D3FAFE212D4996C6AFC10694C15ECAD'
		expect(offlineInstallerDownloadURL(` ${checksum}\n`)).toBe(`/api/offline/v2/installer?sha256=${checksum.toLowerCase()}`)
		expect(offlineInstallerDownloadURL('invalid')).toBe('/api/offline/v2/installer')
	})
})

describe('offline enrollment completion', () => {
	it('publishes active only after the desktop bridge confirms persistence', async () => {
		const calls: string[] = []
		const bridge = {
			bootstrapStatus: async () => ({ state: 'pending' }),
			prepareEnrollment: async () => ({ state: 'pending', terminal_id: 'terminal-1' }),
			completeEnrollment: async () => { calls.push('complete'); return { success: true } },
		}
		const result = await completeApprovedOfflineEnrollment(bridge, { terminal_id: 'terminal-1', state: 'approved' })
		expect(calls).toEqual(['complete'])
		expect(result.state).toBe('active')
	})

	it('does not claim activation when the desktop bridge rejects persistence', async () => {
		const bridge = {
			bootstrapStatus: async () => ({ state: 'pending' }),
			prepareEnrollment: async () => ({ state: 'pending', terminal_id: 'terminal-1' }),
			completeEnrollment: async () => ({ success: false }),
		}
		await expect(completeApprovedOfflineEnrollment(bridge, { terminal_id: 'terminal-1', state: 'approved' }))
			.rejects.toThrow('Windows no pudo instalar')
	})
})

describe('offline selection reconciliation', () => {
	it('does not let a stale initial read overwrite a selection saved by the user', async () => {
		let resolveInitialRead!: (response: Response) => void
		const initialRead = new Promise<Response>((resolve) => { resolveInitialRead = resolve })
		let selectionReads = 0
		let selectionWrites = 0
		const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		})
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (url === '/api/offline/v2/grants') return json({ success: true, grants: [{ id: 'grant-1', account_id: 'account-1', terminal_id: 'terminal-1', modules: ['whiteboards'], quota_bytes: 1, max_offline_seconds: 1, selection_revision: 0 }] })
			if (url.startsWith('/api/offline/v2/conflicts')) return json({ success: true, conflicts: [] })
			if (url.includes('/resources?')) return json({ success: true, items: [{ id: 'board-1', type: 'whiteboard', label: 'Pizarra QA' }] })
			if (url.endsWith('/selections') && init?.method === 'PUT') {
				selectionWrites += 1
				return json({ success: true, selection_revision: 1, selections: [{ id: 'selection-1', module: 'whiteboards', resource_type: 'whiteboard', resource_id: 'board-1', label: 'Pizarra QA' }] })
			}
			if (url.endsWith('/selections')) {
				selectionReads += 1
				return initialRead
			}
			return json({ success: false, error: `unexpected request ${url}` }, 500)
		}))

		render(createElement(OfflineAccessPanel))
		await screen.findByText('Tú decides qué datos estarán disponibles')
		expect(screen.getByText(/Clarin bloquea nuevas sincronizaciones.*máximo en 24 horas/)).toBeTruthy()
		const candidate = await screen.findByRole('button', { name: /Pizarra QA/ }, { timeout: 2_000 })
		fireEvent.click(candidate)
		await waitFor(() => expect(selectionWrites).toBe(1))
		await act(async () => {
			resolveInitialRead(json({ success: true, selection_revision: 0, selections: [] }))
			await Promise.resolve()
		})

		await waitFor(() => expect(screen.getByText('Seleccionados · 1/20')).toBeTruthy())
		expect(selectionReads).toBe(1)
	})
})
