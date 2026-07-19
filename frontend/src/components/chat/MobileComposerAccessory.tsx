'use client'

import { memo } from 'react'
import { Smile, Sticker } from 'lucide-react'
import { EmojiPickerContent } from './EmojiPicker'
import StickerPicker from './StickerPicker'

export type MobileComposerAccessoryTab = 'emoji' | 'sticker'

interface MobileComposerAccessoryProps {
  activeTab: MobileComposerAccessoryTab
  ready: boolean
  height: number
  canSendStickers: boolean
  onTabChange: (tab: MobileComposerAccessoryTab) => void
  onClose: () => void
  onEmojiSelect: (emoji: string) => void
  onStickerSelect: (stickerUrl: string, file?: File) => void | Promise<void>
  savedStickers: string[]
  savedStickerUrls: Set<string>
  savingStickerUrls: Set<string>
  savedLoading: boolean
  savedError: string | null
  onToggleSavedSticker: (stickerUrl: string) => void | Promise<void>
  onRefreshSavedStickers: () => void | Promise<void>
}

function MobileComposerAccessory({
  activeTab,
  ready,
  height,
  canSendStickers,
  onTabChange,
  onClose,
  onEmojiSelect,
  onStickerSelect,
  savedStickers,
  savedStickerUrls,
  savingStickerUrls,
  savedLoading,
  savedError,
  onToggleSavedSticker,
  onRefreshSavedStickers,
}: MobileComposerAccessoryProps) {
  return (
    <section
      id="mobile-composer-accessory"
      data-testid="mobile-composer-accessory"
      aria-label="Emojis y stickers"
      className="flex shrink-0 flex-col overflow-hidden border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)]"
      style={{ height }}
    >
      <div role="tablist" aria-label="Contenido para el mensaje" className="grid h-11 shrink-0 grid-cols-2 border-b border-slate-100 bg-slate-50 px-2">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'emoji'}
          onClick={() => onTabChange('emoji')}
          className={`relative flex min-h-11 items-center justify-center gap-2 px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 ${activeTab === 'emoji' ? 'text-emerald-700' : 'text-slate-500 hover:text-slate-700'}`}
        >
          <Smile className="h-4 w-4" />
          Emojis
          {activeTab === 'emoji' && <span className="absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-emerald-600" />}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'sticker'}
          onClick={() => onTabChange('sticker')}
          disabled={!canSendStickers}
          title={canSendStickers ? undefined : 'Stickers no disponibles para este dispositivo'}
          className={`relative flex min-h-11 items-center justify-center gap-2 px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-40 ${activeTab === 'sticker' ? 'text-emerald-700' : 'text-slate-500 hover:text-slate-700'}`}
        >
          <Sticker className="h-4 w-4" />
          Stickers
          {activeTab === 'sticker' && <span className="absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-emerald-600" />}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden" aria-live="polite">
        {!ready ? (
          <div data-testid="mobile-composer-accessory-loading" className="flex h-full flex-col items-center justify-center gap-3 bg-white text-sm text-slate-400">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-emerald-100 border-t-emerald-600" />
            Preparando {activeTab === 'emoji' ? 'emojis' : 'stickers'}…
          </div>
        ) : activeTab === 'emoji' ? (
          <div role="region" aria-label="Selector de emojis" className="h-full overflow-hidden">
            <EmojiPickerContent onEmojiSelect={onEmojiSelect} width="100%" height="100%" />
          </div>
        ) : (
          <StickerPicker
            embedded
            isOpen
            onToggle={onClose}
            onStickerSelect={onStickerSelect}
            savedStickers={savedStickers}
            savedStickerUrls={savedStickerUrls}
            savingStickerUrls={savingStickerUrls}
            savedLoading={savedLoading}
            savedError={savedError}
            onToggleSavedSticker={onToggleSavedSticker}
            onRefreshSavedStickers={onRefreshSavedStickers}
          />
        )}
      </div>
    </section>
  )
}

export default memo(MobileComposerAccessory)
