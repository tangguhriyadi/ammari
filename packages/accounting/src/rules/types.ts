import type { AccountType } from "@ammari/db/schema";
import type { JournalLineDraft } from "../journal";

// Posting rules are pure functions `snapshot → PostingEvent[]` (docs/plans/accounting.md §2). The
// runner (../runner.ts) loads snapshots and a PostingContext from the database, calls the rule,
// and decides per posting key: nothing (unchanged) | insert | reverse + insert | posting issue.

/** The posting key (source_type, source_id, source_event): at most one active journal per key. */
export interface PostingKey {
  sourceType: string;
  sourceId: string;
  sourceEvent: string;
}

export interface AccountInfo {
  type: AccountType;
  isActive: boolean;
  isHeader: boolean;
}

/** What a rule may read besides its own snapshot. Everything account-related is resolved from the
 * database (account_mappings, accounts.system_key), never from codes typed in a rule, so the
 * accountant can re-point an event without a code change. */
export interface PostingContext {
  /** account_mappings: mapping_key → account code. */
  mappings: ReadonlyMap<string, string>;
  /** accounts.system_key → account code. */
  systemAccounts: ReadonlyMap<string, string>;
  /** Every account by code. */
  accounts: ReadonlyMap<string, AccountInfo>;
  /** Cut-over filter (plan §2): source events dated before this are never posted. */
  postingStartDate: string;
}

export type PostingOutcome =
  /** Post this journal (or keep the identical active one). */
  | { kind: "journal"; description: string; lines: JournalLineDraft[] }
  /** Cannot post: a posting issue, never a guess. An existing active journal is kept. */
  | { kind: "issue"; issueCode: string; details: Record<string, unknown> }
  /** Nothing to post for this key (e.g. dated before the cut-over). An active journal, if any, is
   * reversed. */
  | { kind: "none" };

export interface PostingEvent {
  key: PostingKey;
  /** The source event's own Jakarta date. The entry is dated here, or in the first open month
   * when this month is closed (plan §2, D-23). */
  sourceDate: string;
  outcome: PostingOutcome;
  /** Post this event only while this other key has an active journal; otherwise do nothing (no
   * journal, no issue). Set on voids (E2, P4): a void negates its original, so it is posted only
   * when the original was. An original dated before the cut-over was never posted (its effect is
   * in the opening balances), so neither is its void (plan §2). The runner checks this against
   * the database, which a pure rule cannot see. */
  requiresActiveJournalFor?: PostingKey;
  /** With requiresActiveJournalFor: the other key may sit in the other set of books (books.ts).
   * Set when the event is NOT a negation but a real economic event held back only while the key it
   * builds on is blocked by a posting issue (e.g. a marketplace return held until its sale has a
   * real ship date, Session 9). A void never sets it: a void must stay in its original's books. */
  requiresActiveJournalAcrossBooks?: boolean;
  /** The source has no stable date for this event (a gateway refund is dated by
   * `payments.updated_at`, which any later status read bumps): while the lines are unchanged the
   * active journal keeps its date instead of being reversed and re-posted on the new one. */
  dateFollowsActive?: boolean;
  /** The journal's `kind` (default `system`): `depreciation` for the monthly depreciation (plan
   * §2.1, Session 11), so Jurnal umum can tell it apart. Both are the engine's own journals. */
  entryKind?: EngineEntryKind;
}

/** The kinds of journal the runner writes and re-derives. */
export type EngineEntryKind = "system" | "depreciation";
export const ENGINE_ENTRY_KINDS: readonly EngineEntryKind[] = ["system", "depreciation"];

/** Raised by a rule's account resolution; converted to an issue outcome by `resolveOrIssue`. */
export class PostingIssueError extends Error {
  constructor(
    readonly issueCode: string,
    readonly details: Record<string, unknown>,
  ) {
    super(issueCode);
  }
}

/** The account a mapping key points at; a missing key is the issue `issueCode`. */
export function mappedAccount(context: PostingContext, mappingKey: string, issueCode: string, details: Record<string, unknown> = {}): string {
  const code = context.mappings.get(mappingKey);
  if (!code) throw new PostingIssueError(issueCode, { mappingKey, ...details });
  return code;
}

/** The account holding a system_key; missing means the chart of accounts lost a system row. */
export function systemAccount(context: PostingContext, systemKey: string): string {
  const code = context.systemAccounts.get(systemKey);
  if (!code) throw new PostingIssueError("missing_system_account", { systemKey });
  return code;
}

/** Runs a rule body; a PostingIssueError becomes an issue outcome. */
export function resolveOrIssue(build: () => PostingOutcome): PostingOutcome {
  try {
    return build();
  } catch (error) {
    if (error instanceof PostingIssueError) return { kind: "issue", issueCode: error.issueCode, details: error.details };
    throw error;
  }
}

/** The exact negation of a journal's lines (debit and credit swapped, same accounts and
 * dimensions), for void events (E2, P4). An issue or "none" passes through unchanged. */
export function negateOutcome(outcome: PostingOutcome, description: string): PostingOutcome {
  if (outcome.kind !== "journal") return outcome;
  return {
    kind: "journal",
    description,
    lines: outcome.lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
  };
}

export interface PostingRule<Snapshot> {
  /** For logs and the run report. */
  name: string;
  /** Bumping this re-derives every journal the rule ever posted (reverse + repost, plan §2). */
  ruleVersion: number;
  events(snapshot: Snapshot, context: PostingContext): PostingEvent[];
}
