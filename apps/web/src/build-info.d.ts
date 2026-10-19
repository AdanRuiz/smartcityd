// APP-10: fixed at build time by `define` in vite.config.ts (build/build-info.ts).
declare const __APP_VERSION__: string
/** 40 or 64 hex characters, or '' if the build did not know its commit. */
declare const __APP_COMMIT__: string
/** True if the code that goes into the bundle had uncommitted changes, new files included. */
declare const __APP_DIRTY__: boolean
