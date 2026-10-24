// File-level refusals of the marketplace import: the whole file is not usable, nothing in it is
// previewed. Returned as values (never thrown) so the server action can show the message as is.
// Row- and order-level problems are separate (group-orders.ts): those keep the rest of the file.

export type ImportFileErrorCode =
  | "empty_file"
  | "file_too_large"
  | "unsupported_type"
  | "unsafe_file"
  | "unreadable"
  | "too_many_rows"
  | "too_many_orders"
  | "not_this_channel"
  | "missing_columns"
  | "ambiguous_columns"
  | "channel_not_ready";

export interface ImportFileError {
  code: ImportFileErrorCode;
  /** Indonesian, shown to the owner as is. Never contains cell contents from buyer columns. */
  message: string;
}

export type FileResult<T> = { ok: true; value: T } | { ok: false; error: ImportFileError };

export function fileError(code: ImportFileErrorCode, message: string): { ok: false; error: ImportFileError } {
  return { ok: false, error: { code, message } };
}
