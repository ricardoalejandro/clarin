type DataURL = string;
export declare class ExcalidrawFontFace {
    readonly urls: URL[] | DataURL[];
    fontFace: FontFace;
    private readonly family;
    private readonly sources;
    private readonly descriptors?;
    private static readonly ASSETS_FALLBACK_URL;
    constructor(family: string, uri: string, descriptors?: FontFaceDescriptors);
    private createFontFace;
    /** A FontFace in the error state is terminal in browsers and must be replaced. */
    resetAfterLoadFailure(): FontFace;
    /**
     * Generates CSS `@font-face` definition with the (subsetted) font source as a data url for the characters within the unicode range.
     *
     * Retrieves `undefined` otherwise.
     */
    toCSS(characters: string): Promise<string> | undefined;
    /**
     * Tries to fetch woff2 content, based on the registered urls (from first to last, treated as fallbacks).
     *
     * @returns base64 with subsetted glyphs based on the passed codepoint, last defined url otherwise
     */
    getContent(codePoints: Array<number>): Promise<string>;
    fetchFont(url: URL | DataURL): Promise<ArrayBuffer>;
    private getUnicodeRangeRegex;
    private static createUrls;
    private static getFormat;
    private static normalizeBaseUrl;
}
export {};
