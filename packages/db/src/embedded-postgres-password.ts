// BLA-433: embedded PostgreSQL password from a server-only 0600 file.
//
// PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE unset => the legacy default
// password "paperclip" (stage A, inert). Set but unreadable, empty or
// malformed (an embedded CR/LF after stripping one trailing newline) => throw,
// so startup fails closed; there is no fallback to the legacy password.
// The value is read once per process and cached, like the dist overlay.
import { readFileSync } from "node:fs";

export const EMBEDDED_POSTGRES_PASSWORD_FILE_ENV = "PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE";
export const LEGACY_EMBEDDED_POSTGRES_PASSWORD = "paperclip";

let cachedPassword: string | null = null;

export function embeddedPostgresPassword(): string {
  if (cachedPassword !== null) return cachedPassword;
  const file = process.env[EMBEDDED_POSTGRES_PASSWORD_FILE_ENV];
  if (!file) return (cachedPassword = LEGACY_EMBEDDED_POSTGRES_PASSWORD);
  const value = readFileSync(file, "utf8").replace(/\r?\n$/, "");
  if (!value || /[\r\n]/.test(value)) {
    throw new Error(`${EMBEDDED_POSTGRES_PASSWORD_FILE_ENV} is empty or malformed`);
  }
  return (cachedPassword = value);
}

/** The password, percent-encoded for a postgres:// connection URI. */
export function embeddedPostgresPasswordUri(): string {
  return encodeURIComponent(embeddedPostgresPassword());
}

/** Test-only: forget the cached value so the env var is re-read. */
export function __resetEmbeddedPostgresPasswordCacheForTests(): void {
  cachedPassword = null;
}
