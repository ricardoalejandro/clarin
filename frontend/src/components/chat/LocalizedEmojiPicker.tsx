'use client'

import EmojiPickerReact, { PickerProps } from 'emoji-picker-react'
import spanishEmojiData from 'emoji-picker-react/dist/data/emojis-es-mx'

export default function LocalizedEmojiPicker({
  searchPlaceHolder = 'Buscar emoji...',
  searchClearButtonLabel = 'Limpiar búsqueda',
  ...props
}: PickerProps) {
  return (
    <EmojiPickerReact
      {...props}
      emojiData={spanishEmojiData}
      searchPlaceHolder={searchPlaceHolder}
      searchClearButtonLabel={searchClearButtonLabel}
    />
  )
}
