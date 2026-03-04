/**
 * Client-side image compression utility.
 *
 * Mimics WhatsApp's behavior:
 *  - Standard: max 1600px on the longest side, JPEG quality 0.70  → ~100-300 KB
 *  - HD:       max 2560px on the longest side, JPEG quality 0.85  → ~500 KB-1.5 MB
 *
 * GIFs are NOT compressed (they may be animated).
 * Images already small enough are returned as-is.
 */

export interface CompressOptions {
  /** Maximum pixels on the longest side (default: 1600) */
  maxDimension?: number
  /** JPEG output quality 0-1 (default: 0.70) */
  quality?: number
  /** Skip compression if original file is smaller than this (bytes). Default: 200 KB */
  skipBelowBytes?: number
}

const DEFAULT_OPTIONS: Required<CompressOptions> = {
  maxDimension: 1600,
  quality: 0.70,
  skipBelowBytes: 200 * 1024, // 200 KB
}

/**
 * Compress an image File using the browser Canvas API.
 * Returns a new File (JPEG) or the original if compression isn't needed.
 */
export async function compressImage(
  file: File,
  opts?: CompressOptions,
): Promise<File> {
  const { maxDimension, quality, skipBelowBytes } = { ...DEFAULT_OPTIONS, ...opts }

  // Don't touch GIFs (may be animated) or non-image files
  if (file.type === 'image/gif' || !file.type.startsWith('image/')) {
    return file
  }

  // Skip tiny images — they don't need compression
  if (file.size <= skipBelowBytes) {
    return file
  }

  return new Promise<File>((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)

      let { width, height } = img

      // Check if resize is needed
      const longestSide = Math.max(width, height)
      const needsResize = longestSide > maxDimension
      const needsCompress = file.size > skipBelowBytes

      if (!needsResize && !needsCompress) {
        resolve(file)
        return
      }

      // Calculate new dimensions maintaining aspect ratio
      if (needsResize) {
        const scale = maxDimension / longestSide
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }

      // Draw on canvas
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(file)
        return
      }

      ctx.drawImage(img, 0, 0, width, height)

      // Export as JPEG blob
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(file)
            return
          }

          // If compressed version is actually larger, return original
          if (blob.size >= file.size) {
            resolve(file)
            return
          }

          // Build a new File with the compressed data
          const ext = '.jpg'
          const baseName = file.name.replace(/\.[^.]+$/, '')
          const compressed = new File([blob], baseName + ext, {
            type: 'image/jpeg',
            lastModified: Date.now(),
          })

          console.log(
            `[ImageCompress] ${file.name}: ${(file.size / 1024).toFixed(0)} KB → ${(compressed.size / 1024).toFixed(0)} KB ` +
            `(${width}×${height}, q=${quality})`
          )

          resolve(compressed)
        },
        'image/jpeg',
        quality,
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(file) // fallback to original
    }

    img.src = url
  })
}

/**
 * Compress an image with WhatsApp-standard settings (1600px, 70% quality).
 */
export function compressImageStandard(file: File): Promise<File> {
  return compressImage(file, { maxDimension: 1600, quality: 0.70 })
}

/**
 * Compress an image with WhatsApp-HD settings (2560px, 85% quality).
 */
export function compressImageHD(file: File): Promise<File> {
  return compressImage(file, { maxDimension: 2560, quality: 0.85 })
}
