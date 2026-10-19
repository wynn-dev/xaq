// Attaching a Google Drive file (drive_file_id): what to fetch (Google-native files are exported, PDF by default;
// others downloaded as they are), under which name and type, and Drive's errors in plain words.

import type { DriveFile } from "../google/drive.ts";
import { hasReason } from "../google/http.ts";
import { GoogleApiError } from "../google/types.ts";
import { AttachmentError, type DriveExportFormat } from "./attachments.ts";

const APPS = "application/vnd.google-apps.";

/** The MIME type Drive exports each format as, and the file extension. */
const FORMATS: Record<DriveExportFormat, { mime: string; ext: string }> = {
  pdf: { mime: "application/pdf", ext: "pdf" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" },
  csv: { mime: "text/csv", ext: "csv" },
  txt: { mime: "text/plain", ext: "txt" },
  md: { mime: "text/markdown", ext: "md" },
};

/** Which formats each Google-native type exports to (developers.google.com/workspace/drive/api/guides/ref-export-formats). */
const EXPORTS: Record<string, { what: string; formats: DriveExportFormat[] }> = {
  [`${APPS}document`]: { what: "Google Doc", formats: ["pdf", "docx", "txt", "md"] },
  [`${APPS}spreadsheet`]: { what: "Google Sheet", formats: ["pdf", "xlsx", "csv"] },
  [`${APPS}presentation`]: { what: "Google Slides deck", formats: ["pdf", "pptx", "txt"] },
  [`${APPS}drawing`]: { what: "Google Drawing", formats: ["pdf"] },
};

/** What fetching a Drive file means: a download, or an export to `format`. */
export type DrivePlan =
  | { kind: "download"; filename: string; mimeType: string; size: number | null }
  | { kind: "export"; filename: string; mimeType: string; format: DriveExportFormat };

/** Decides how to attach `file` (metadata from files.get). Throws AttachmentError when it can't be attached. */
export function planDriveFile(label: string, file: DriveFile, exportAs: DriveExportFormat | undefined): DrivePlan {
  const name = file.name || file.id;
  if (file.trashed) throw new AttachmentError("not_found", `${label}: the Drive file ${name} is in the trash.`);
  if (exportAs !== undefined && !(exportAs in FORMATS)) {
    throw new AttachmentError("invalid_attachment", `${label}: export_as must be one of ${Object.keys(FORMATS).join(", ")}.`);
  }
  const native = EXPORTS[file.mimeType];
  if (native) {
    const format = exportAs ?? "pdf";
    if (!native.formats.includes(format)) {
      throw new AttachmentError("invalid_attachment", `${label}: ${name} is a ${native.what}, which exports as ${native.formats.join(", ")}, not ${format}.`);
    }
    const { mime, ext } = FORMATS[format];
    const filename = name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
    return { kind: "export", filename, mimeType: mime, format };
  }
  if (file.mimeType === `${APPS}folder`) throw new AttachmentError("invalid_attachment", `${label}: ${name} is a Drive folder; attach the files in it one by one.`);
  if (file.mimeType === `${APPS}shortcut`) {
    const target = file.shortcutDetails?.targetId;
    throw new AttachmentError("invalid_attachment", `${label}: ${name} is a Drive shortcut${target ? `; pass the file it points to, drive_file_id "${target}"` : ""}.`);
  }
  if (file.mimeType.startsWith(APPS)) {
    throw new AttachmentError("invalid_attachment", `${label}: ${name} is a Google file type (${file.mimeType.slice(APPS.length)}) that can't be exported as a file; put its link in the body instead${file.webViewLink ? `: ${file.webViewLink}` : ""}.`);
  }
  if (exportAs !== undefined && FORMATS[exportAs].mime !== file.mimeType) {
    throw new AttachmentError(
      "invalid_attachment",
      `${label}: export_as only applies to Google Docs, Sheets, Slides and Drawings; ${name} is a ${file.mimeType} file and is attached as it is. Leave out export_as.`,
    );
  }
  const size = file.size !== undefined && /^\d+$/.test(file.size) ? Number(file.size) : null;
  return { kind: "download", filename: name, mimeType: file.mimeType || "application/octet-stream", size };
}

/** Drive's error for a file id, in words the agent can act on. Anything unrecognised is returned unchanged. */
export function driveError(err: unknown, label: string, fileId: string, accountEmail: string, file?: DriveFile): unknown {
  if (!(err instanceof GoogleApiError)) return err;
  const name = file?.name ?? fileId;
  const link = file?.webViewLink ? ` Put its link in the body instead: ${file.webViewLink}` : "";
  if (err.status === 404) return new AttachmentError("not_found", `${label}: no Drive file ${fileId} that ${accountEmail} can open (check the id, or share the file with ${accountEmail}).`);
  if (hasReason(err, "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions")) return driveNotEnabled(accountEmail);
  if (hasReason(err, "SERVICE_DISABLED", "accessNotConfigured")) {
    const url = err.details.metadata?.activationUrl;
    return new AttachmentError("drive_error", `The Google Drive API isn't enabled in xaq's Google Cloud project, so Drive files can't be attached.${url ? ` The owner can enable it at ${url}.` : ""}`);
  }
  if (hasReason(err, "exportSizeLimitExceeded")) {
    return new AttachmentError("too_large", `${label}: ${name} is too large for Google Drive to export as a file (Google exports at most 10 MB).${link || " Put its Drive link in the body instead."}`);
  }
  if (hasReason(err, "cannotDownloadFile", "cannotExportFile")) {
    return new AttachmentError("drive_error", `${label}: the owner of ${name} doesn't allow downloading or exporting it.${link}`);
  }
  if (err.status === 403) return new AttachmentError("drive_error", `${label}: Google Drive refused access to ${name}: ${err.message}`);
  return err;
}

/** The plain refusal when the account hasn't granted Drive read access. */
export const driveNotEnabled = (accountEmail: string): AttachmentError =>
  new AttachmentError(
    "drive_not_enabled",
    `Drive isn't enabled for ${accountEmail}: install the google-workspace extension and enable Drive in xaq (Connections → Google Workspace)`,
  );
