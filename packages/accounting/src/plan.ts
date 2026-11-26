import { createHash } from "node:crypto";
import { journalLinesProblems, type JournalLineDraft } from "./journal";
import { purchaseGuardViolations } from "./purchase-guard";
import type { PostingContext, PostingEvent, PostingKey } from "./rules/types";

// The pure half of the runner (docs/plans/accounting.md §2): turns a rule's event into what the
// database should hold for that key, so every decision is unit-testable without a database.

/** sha256 of what makes a journal "the same": the rule version, the source date, and every line's
 * account, amounts and dimensions in order. Description and memo are left out on purpose: a
 * renamed category or supplier must not re-post history. The entry date is left out too: it moves
 * to the first open month when a period closes, which is not a change of content. */
export function journalContentHash(ruleVersion: number, sourceDate: string, lines: readonly JournalLineDraft[]): string {
  const normalised = {
    v: ruleVersion,
    d: sourceDate,
    l: lines.map((line) => [
      line.accountCode,
      line.debit,
      line.credit,
      line.channelId ?? null,
      line.supplierId ?? null,
      line.orderId ?? null,
      line.cashAccountCode ?? null,
    ]),
  };
  return createHash("sha256").update(JSON.stringify(normalised)).digest("hex");
}

export type PlannedOutcome =
  | {
      kind: "journal";
      key: PostingKey;
      sourceDate: string;
      ruleVersion: number;
      description: string;
      lines: JournalLineDraft[];
      contentHash: string;
      /** PostingEvent.dateFollowsActive. */
      dateFollowsActive?: boolean;
    }
  | { kind: "issue"; key: PostingKey; sourceDate: string; issueCode: string; details: Record<string, unknown> }
  | { kind: "none"; key: PostingKey; sourceDate: string };

/** Validates a rule's journal before anything is written (plan §4.8: a rule that cannot balance
 * raises a posting issue instead of plugging silently): the lines' shape and balance (same rules
 * as the database), every account postable, and the D-14 guard for purchase-side sources. */
export function planEvent(event: PostingEvent, ruleVersion: number, context: PostingContext): PlannedOutcome {
  const { key, sourceDate, outcome } = event;
  if (outcome.kind === "none") return { kind: "none", key, sourceDate };
  if (outcome.kind === "issue") return { kind: "issue", key, sourceDate, issueCode: outcome.issueCode, details: outcome.details };

  const problems = journalLinesProblems(outcome.lines);
  if (problems.length > 0) return { kind: "issue", key, sourceDate, issueCode: "invalid_journal", details: { problems } };

  const notPostable = [
    ...new Set(
      outcome.lines.flatMap((line) => [line.accountCode, line.cashAccountCode].filter((code): code is string => typeof code === "string")),
    ),
  ].filter((code) => {
    const account = context.accounts.get(code);
    return !account || !account.isActive || account.isHeader;
  });
  if (notPostable.length > 0) return { kind: "issue", key, sourceDate, issueCode: "account_not_postable", details: { accountCodes: notPostable } };

  const guardViolations = purchaseGuardViolations(key, outcome.lines, (code) => context.accounts.get(code)?.type);
  if (guardViolations.length > 0) {
    return {
      kind: "issue",
      key,
      sourceDate,
      issueCode: "purchase_guard_violation",
      details: { accountCodes: [...new Set(guardViolations.map((line) => line.accountCode))] },
    };
  }

  return {
    kind: "journal",
    key,
    sourceDate,
    ruleVersion,
    description: outcome.description,
    lines: outcome.lines,
    contentHash: journalContentHash(ruleVersion, sourceDate, outcome.lines),
    ...(event.dateFollowsActive ? { dateFollowsActive: true } : {}),
  };
}

/** The active journal's content hash as the runner compares it: for an event whose date follows
 * the active journal (PostingEvent.dateFollowsActive), an active journal with the same lines on its
 * own (older) source date counts as identical, so the event is "unchanged" rather than re-dated. */
export function comparableActiveHash(planned: PlannedOutcome, active: { contentHash: string | null; sourceDate: string | null } | undefined): string | null | undefined {
  if (!active) return undefined;
  if (planned.kind === "journal" && planned.dateFollowsActive && active.sourceDate && active.sourceDate !== planned.sourceDate) {
    const onActiveDate = journalContentHash(planned.ruleVersion, active.sourceDate, planned.lines);
    if (onActiveDate === active.contentHash) return planned.contentHash;
  }
  return active.contentHash;
}

export type KeyAction = "unchanged" | "insert" | "reverse_and_insert" | "reverse" | "issue" | "skip";

/** What the runner does for one key, given the active journal's content hash (null = none). */
export function decideAction(planned: PlannedOutcome, activeContentHash: string | null | undefined): KeyAction {
  const hasActive = activeContentHash !== undefined;
  switch (planned.kind) {
    case "journal":
      if (!hasActive) return "insert";
      return activeContentHash === planned.contentHash ? "unchanged" : "reverse_and_insert";
    case "issue":
      // Never un-post because of an issue (e.g. a mapping went missing): keep what is booked and
      // surface the issue.
      return "issue";
    case "none":
      return hasActive ? "reverse" : "skip";
  }
}
