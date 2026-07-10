declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: Record<string, unknown>)
    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    focus(): void
    disconnect(): void
  }
}
