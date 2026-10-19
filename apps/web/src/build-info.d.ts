// APP-10: fixed at build time by `define` in vite.config.ts (build/build-info.ts).
declare const __APP_VERSION__: string
/** 40 or 64 hex characters, or '' if the build did not know its commit. */
declare const __APP_COMMIT__: string
/** True if the build was made from a working tree with uncommitted changes to tracked files. */
declare const __APP_DIRTY__: boolean
