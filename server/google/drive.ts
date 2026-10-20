// Google Drive v3 REST, read-only and minimal: file metadata, downloads and exports, for attaching Drive files to
// mail (server/mail/drive-files.ts). Built on GoogleRuntime.request like gmail.ts and calendar.ts (token refresh,
// 401 retry, backoff, AccountNeedsReauthError); base URL ctx.config.google.apisBase (default https://www.googleapis.com)
// + "/drive/v3".
// https://developers.google.com/workspace/drive/api/reference/rest/v3/files

import type { AppContext } from "../context.ts";
import { googleRuntime } from "./runtime.ts";
import { DRIVE_READONLY_SCOPE } from "./scopes.ts";

/** Full Drive access also covers reading. */
const DRIVE_FULL_SCOPE = "https://www.googleapis.com/auth/drive";

/** Whether these granted scopes let xaq read the user's Drive files. */
export const canReadDrive = (granted: readonly string[] | null | undefined): boolean =>
  !!granted && (granted.includes(DRIVE_READONLY_SCOPE) || granted.includes(DRIVE_FULL_SCOPE));

/** The files.get fields xaq uses. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Bytes, as a decimal string; absent for Google Docs, Sheets, Slides and other Google-native files. */
  size?: string;
  /** The file's page in Drive, for a link in the body. */
  webViewLink?: string;
  trashed?: boolean;
  /** For shortcuts (mimeType application/vnd.google-apps.shortcut). */
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

export interface DriveClient {
  getFile(fileId: string): Promise<DriveFile>;
  /** The file's bytes (alt=media). Refuses with ResponseTooLargeError past `maxBytes`. */
  download(fileId: string, maxBytes: number): Promise<Buffer>;
  /** A Google-native file exported to `mimeType`. Refuses with ResponseTooLargeError past `maxBytes`. */
  exportFile(fileId: string, mimeType: string, maxBytes: number): Promise<Buffer>;
}

const FIELDS = "id,name,mimeType,size,webViewLink,trashed,shortcutDetails";

/** Downloads take longer: 30 s plus 1 s per 256 KB they may carry, at most 10 minutes. */
const downloadTimeout = (maxBytes: number) => Math.min(600_000, 30_000 + Math.ceil(maxBytes / 262_144) * 1000);

export function createDriveClient(ctx: AppContext, accountId: string): DriveClient {
  const rt = googleRuntime(ctx);
  const base = ctx.config.google.apisBase ?? "https://www.googleapis.com";
  const path = (fileId: string, suffix = "") => `/drive/v3/files/${encodeURIComponent(fileId)}${suffix}`;
  return {
    getFile: (fileId) => rt.request<DriveFile>(accountId, base, path(fileId), { query: { fields: FIELDS, supportsAllDrives: true } }),
    download: (fileId, maxBytes) =>
      rt.request<Buffer>(accountId, base, path(fileId), {
        query: { alt: "media", supportsAllDrives: true },
        binary: true,
        maxResponseBytes: maxBytes,
        timeoutMs: downloadTimeout(maxBytes),
      }),
    exportFile: (fileId, mimeType, maxBytes) =>
      rt.request<Buffer>(accountId, base, path(fileId, "/export"), {
        query: { mimeType },
        binary: true,
        maxResponseBytes: maxBytes,
        timeoutMs: downloadTimeout(maxBytes),
      }),
  };
}
