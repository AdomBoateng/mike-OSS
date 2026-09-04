import type { ChatMessage } from "./chatTools";

const MAX_CHAT_MESSAGES = 200;
const MAX_CHAT_CONTENT_CHARS = 1_000_000;
export const MAX_SHARED_EMAILS = 100;
export const MAX_REVIEW_DOCUMENTS = 200;
export const MAX_REVIEW_COLUMNS = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLUMN_FORMATS = new Set([
  "text",
  "bulleted_list",
  "number",
  "currency",
  "yes_no",
  "date",
  "tag",
  "percentage",
  "monetary_amount",
]);

export function parseChatMessages(value: unknown):
  | { ok: true; messages: ChatMessage[] }
  | { ok: false; detail: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, detail: "messages must be a non-empty array" };
  }
  if (value.length > MAX_CHAT_MESSAGES) {
    return {
      ok: false,
      detail: `messages may not exceed ${MAX_CHAT_MESSAGES} entries`,
    };
  }

  let contentChars = 0;
  for (const message of value) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { ok: false, detail: "messages must contain objects" };
    }
    const row = message as Record<string, unknown>;
    if (row.role !== "user" && row.role !== "assistant") {
      return { ok: false, detail: "message.role must be user or assistant" };
    }
    if (row.content !== null && typeof row.content !== "string") {
      return {
        ok: false,
        detail: "message.content must be a string or null",
      };
    }
    contentChars += typeof row.content === "string" ? row.content.length : 0;
    if (contentChars > MAX_CHAT_CONTENT_CHARS) {
      return {
        ok: false,
        detail: "combined message content is too large",
      };
    }
  }
  return { ok: true, messages: value as ChatMessage[] };
}

export function normalizeSharedEmails(
  value: unknown,
  selfEmail: string | null | undefined,
  subject: string,
): { ok: true; emails: string[] } | { ok: false; detail: string } {
  if (!Array.isArray(value)) {
    return { ok: false, detail: "emails must be an array" };
  }
  if (value.length > MAX_SHARED_EMAILS) {
    return {
      ok: false,
      detail: `You may share ${subject} with at most ${MAX_SHARED_EMAILS} people at once.`,
    };
  }

  const normalizedSelf = selfEmail?.trim().toLowerCase();
  const emails: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") {
      return { ok: false, detail: "Every email must be a string." };
    }
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    if (email.length > 254 || !EMAIL_RE.test(email)) {
      return { ok: false, detail: `Invalid email address: ${email.slice(0, 254)}` };
    }
    if (normalizedSelf && email === normalizedSelf) {
      return {
        ok: false,
        detail: `You cannot share ${subject} with yourself.`,
      };
    }
    seen.add(email);
    emails.push(email);
  }
  return { ok: true, emails };
}

export function parseDocumentIds(value: unknown):
  | { ok: true; ids: string[] }
  | { ok: false; detail: string } {
  if (!Array.isArray(value)) {
    return { ok: false, detail: "document_ids must be an array" };
  }
  if (value.length > MAX_REVIEW_DOCUMENTS) {
    return {
      ok: false,
      detail: `document_ids may not exceed ${MAX_REVIEW_DOCUMENTS} entries`,
    };
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim() || raw.length > 100) {
      return { ok: false, detail: "document_ids contains an invalid id" };
    }
    const id = raw.trim();
    if (!seen.has(id)) ids.push(id);
    seen.add(id);
  }
  return { ok: true, ids };
}

export type ValidatedColumn = {
  index: number;
  name: string;
  prompt: string;
  format?: string;
  tags?: string[];
};

export function parseReviewColumns(value: unknown):
  | { ok: true; columns: ValidatedColumn[] }
  | { ok: false; detail: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, detail: "columns_config must be a non-empty array" };
  }
  if (value.length > MAX_REVIEW_COLUMNS) {
    return {
      ok: false,
      detail: `columns_config may not exceed ${MAX_REVIEW_COLUMNS} entries`,
    };
  }
  const columns: ValidatedColumn[] = [];
  const indexes = new Set<number>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, detail: "columns_config contains an invalid column" };
    }
    const row = raw as Record<string, unknown>;
    if (
      !Number.isSafeInteger(row.index) ||
      (row.index as number) < 0 ||
      indexes.has(row.index as number) ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      row.name.length > 200 ||
      typeof row.prompt !== "string" ||
      row.prompt.length > 20_000
    ) {
      return { ok: false, detail: "columns_config contains an invalid column" };
    }
    if (
      row.format !== undefined &&
      (typeof row.format !== "string" || !COLUMN_FORMATS.has(row.format))
    ) {
      return { ok: false, detail: "columns_config contains an invalid format" };
    }
    if (
      row.tags !== undefined &&
      (!Array.isArray(row.tags) ||
        row.tags.length > 100 ||
        row.tags.some((tag) => typeof tag !== "string" || tag.length > 100))
    ) {
      return { ok: false, detail: "columns_config contains invalid tags" };
    }
    indexes.add(row.index as number);
    columns.push({
      index: row.index as number,
      name: row.name.trim(),
      prompt: row.prompt,
      ...(typeof row.format === "string" ? { format: row.format } : {}),
      ...(Array.isArray(row.tags) ? { tags: row.tags as string[] } : {}),
    });
  }
  return { ok: true, columns };
}
