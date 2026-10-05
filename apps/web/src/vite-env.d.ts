/// <reference types="vite/client" />

declare const __TEST_HOOKS__: boolean;

interface ImportMetaEnv {
  readonly VITE_TURNSTILE_SITEKEY?: string;
}
