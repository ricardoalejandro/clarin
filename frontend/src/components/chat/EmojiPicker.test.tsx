import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./LocalizedEmojiPicker', () => ({
  default: ({ onEmojiClick, skinTonesDisabled }: { onEmojiClick: (value: { emoji: string }) => void; skinTonesDisabled?: boolean }) => (
    <div>
      <span data-testid="skin-tones-enabled">{String(skinTonesDisabled !== true)}</span>
      <button type="button" onClick={() => onEmojiClick({ emoji: '👋🏽' })}>Elegir 👋🏽</button>
    </div>
  ),
}))

import { EmojiPickerContent } from './EmojiPicker'

describe('EmojiPickerContent', () => {
  it('keeps skin tones enabled and emits the exact selected Unicode sequence', async () => {
    const onEmojiSelect = vi.fn()
    render(<EmojiPickerContent onEmojiSelect={onEmojiSelect} width={350} height={400} />)

    expect(await screen.findByTestId('skin-tones-enabled')).toHaveTextContent('true')
    fireEvent.click(screen.getByRole('button', { name: 'Elegir 👋🏽' }))
    expect(onEmojiSelect).toHaveBeenCalledWith('👋🏽')
  })
})
