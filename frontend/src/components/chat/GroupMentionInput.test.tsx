import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { serializeMentions, type MentionRange } from '@/utils/chatMentions'
vi.mock('../WhatsAppTextInput', async () => {
  const React = await import('react')
  return { default: React.forwardRef(function Input(props: any, ref: any) {
    const selection = React.useRef({ start: props.value.length, end: props.value.length })
    React.useImperativeHandle(ref, () => ({ getSelection: () => selection.current, setSelection: (next: any) => { selection.current = next }, focus() {}, blur() {}, clear() {}, insertAtCaret() {} }))
    return <textarea aria-label="Mensaje" value={props.value} onChange={event => { selection.current = { start: event.target.value.length, end: event.target.value.length }; props.onChange(event.target.value, 'input') }} onKeyDown={props.onKeyDown} />
  }) }
})
import GroupMentionInput from './GroupMentionInput'
function Harness() {
  const [text, setText] = useState(''), [mentions, setMentions] = useState<MentionRange[]>([])
  return <><GroupMentionInput chatId="group" value={text} onChange={setText} mentions={mentions} onMentionsChange={setMentions} /><output data-testid="wire">{JSON.stringify(serializeMentions(text, mentions))}</output></>
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })
describe('group mention picker', () => {
  it('waits exactly 500 ms, aborts the previous query, and selects structured identity with undo', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn((_url: string, _options: RequestInit) => Promise.resolve({ ok: true, json: async () => ({ success: true, participants: [{ jid: '51900@s.whatsapp.net', name: 'María León', role: 'member', is_self: false }] }) }))
    vi.stubGlobal('fetch', fetcher)
    render(<Harness />)
    const editor = screen.getByRole('textbox', { name: 'Mensaje' })
    fireEvent.change(editor, { target: { value: 'Hola @Ma' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(499) }); expect(fetcher).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) }); expect(fetcher).toHaveBeenCalledTimes(1)
    fireEvent.change(editor, { target: { value: 'Hola @Mar' } })
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    fireEvent.click(screen.getByRole('option', { name: 'María León' }))
    expect(editor).toHaveValue('Hola @María León ')
    expect(JSON.parse(screen.getByTestId('wire').textContent || '{}')).toEqual({ body: 'Hola @51900 ', mentions: [{ jid: '51900@s.whatsapp.net', name: 'María León' }] })
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true })
    expect(editor).toHaveValue('Hola @Mar')
    expect(screen.queryByLabelText('Personas mencionadas')).toBeNull()
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(editor).toHaveValue('Hola @María León ')
    expect(screen.getByLabelText('Personas mencionadas')).toBeInTheDocument()
  })
  it('does not infer notifications from plain pasted names and allows removing metadata', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ success: true, participants: [{ jid: '51900@s.whatsapp.net', name: 'María León', role: 'member', is_self: false }] }) })))
    render(<Harness />)
    const editor = screen.getByRole('textbox', { name: 'Mensaje' })
    fireEvent.change(editor, { target: { value: '@María León' } })
    expect(JSON.parse(screen.getByTestId('wire').textContent || '{}').mentions).toEqual([])
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    fireEvent.click(screen.getByRole('option', { name: 'María León' }))
    fireEvent.click(screen.getByRole('button', { name: 'Quitar mención de María León' }))
    expect(editor).toHaveValue('@María León ')
    expect(JSON.parse(screen.getByTestId('wire').textContent || '{}').mentions).toEqual([])
  })
})
