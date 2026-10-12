/** Resolve only a versioned Clarin asset on the page's own HTTP(S) origin. */
export const resolveClarinSubsetWorkerUrl = (
  assetPath: unknown,
  pageURL: string,
): URL | undefined => {
  try {
    const page = new URL(pageURL);
    if (!/^https?:$/.test(page.protocol)) {
      return undefined;
    }
    const paths = Array.isArray(assetPath) ? assetPath : [assetPath];
    for (const path of paths) {
      if (typeof path !== "string") {
        continue;
      }
      try {
        const base = new URL(path, page.origin);
        if (
          base.origin === page.origin &&
          !base.username && !base.password && !base.search && !base.hash &&
          (/^\/vendor\/whiteboards-editor\/[0-9][0-9A-Za-z.+-]*\/$/.test(base.pathname) ||
            /^\/offline-v[345]\/whiteboard-assets\/$/.test(base.pathname))
        ) {
          return new URL("subset-worker.js", base);
        }
      } catch {
        // An invalid optional asset base must never fall back to a CDN/file URL.
      }
    }
  } catch {
    // Unsupported contexts retain the existing main-thread fallback.
  }
  return undefined;
};
