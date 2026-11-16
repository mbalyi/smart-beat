/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * The Sentry DSN of the UI's crash-report project (docs/crash-reports.md), set at build time by
   * vite.config.ts. Absent: the UI side of crash reports does nothing.
   */
  readonly VITE_SENTRY_DSN_FRONTEND?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
