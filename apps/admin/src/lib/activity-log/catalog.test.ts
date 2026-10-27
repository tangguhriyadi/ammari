import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ACTIVITY_AREAS, AUDIT_CATALOG, type ActivityArea, type AreaMembership, areaMembership, describeAction, isActivityArea } from "./catalog";

// Every audit_log write in the codebase must have a label (docs/plans/activity-log.md §5). This
// scans every non-test .ts/.tsx under apps/*/src and packages/*/src for a `writeAuditLog(` call or
// an `.insert(auditLog).values(` and resolves its `entityType` and `action` statically: string
// literals (including both arms of a ternary), a same-file `const X = "..."`, or a same-file
// `X.member` of an object literal (STAFF_AUDIT_ACTIONS). Anything else must be listed in
// DYNAMIC_SITES with the values it can take, so a new writer can never slip past unlabelled.

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../../../..");

/** Call sites whose action is a parameter, with every value their callers pass. */
const DYNAMIC_SITES: { file: string; actionExpression: string; entityType: string; actions: string[] }[] = [
  {
    file: "packages/commerce/src/shipping/tracking.ts",
    actionExpression: "options.action",
    entityType: "order",
    // applyShipmentSnapshot's callers: tracking.ts (poll/webhook) and bookings.ts (staff reads).
    actions: ["book_shipment", "refresh_shipment", "track_shipment_poll", "track_shipment_webhook"],
  },
];

/** The helpers' own bodies forward their parameters; they are not call sites. */
const WRAPPER_BODIES = new Set(["params.action"]);

interface ScannedWrite {
  location: string;
  entityType: string;
  actions: string[];
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(full);
  }
  return files;
}

function workspaceSources(): string[] {
  const files: string[] = [];
  for (const group of ["apps", "packages"]) {
    for (const workspace of readdirSync(path.join(repoRoot, group))) {
      const src = path.join(repoRoot, group, workspace, "src");
      try {
        if (statSync(src).isDirectory()) files.push(...sourceFiles(src));
      } catch {
        // a workspace without src/
      }
    }
  }
  return files;
}

/** The text between the call's opening paren and its matching close. */
function callArguments(source: string, openIndex: number): string {
  let depth = 1;
  let index = openIndex;
  while (depth > 0 && index < source.length) {
    const char = source[index];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    index++;
  }
  return source.slice(openIndex, index - 1);
}

/** The expression after `key:` at the call's own object level (depth 1 of the arguments, so a
 * nested `before: { action: ... }` never shadows it), up to the next comma at that level. */
function propertyExpression(args: string, key: string): string | null {
  let depth = 0;
  for (let index = 0; index < args.length; index++) {
    const char = args[index];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (depth === 1 && /[\s{,]/.test(args[index - 1] ?? " ")) {
      const match = new RegExp(`^${key}\\s*:\\s*`).exec(args.slice(index));
      if (!match) continue;
      let inner = 0;
      let end = index + match[0].length;
      const start = end;
      while (end < args.length) {
        const c = args[end];
        if (c === "(" || c === "[" || c === "{") inner++;
        else if (c === ")" || c === "]" || c === "}") {
          if (inner === 0) break;
          inner--;
        } else if (c === "," && inner === 0) break;
        end++;
      }
      return args.slice(start, end).trim();
    }
  }
  return null;
}

const STRING_LITERAL = /"([^"\\]*)"/g;
/** A literal, or a ternary whose two arms are both literals. Anything mixing a literal with an
 * identifier (`cond ? "a" : someVar`) is NOT resolved, so its unknown arm can't be dropped. */
const LITERAL_ONLY = /^(?:"[^"\\]*"|[\w.!?]+\s*\?\s*"[^"\\]*"\s*:\s*"[^"\\]*")$/;

function resolveExpression(expression: string, source: string): string[] | null {
  if (LITERAL_ONLY.test(expression)) return [...expression.matchAll(STRING_LITERAL)].map((match) => match[1]!);
  if (expression.includes('"')) return null;
  const constant = /^([A-Z_][A-Z0-9_]*)$/.exec(expression);
  if (constant) {
    const declared = new RegExp(`^\\s*(?:export\\s+)?const ${constant[1]} = "([^"]+)";`, "m").exec(source);
    return declared ? [declared[1]!] : null;
  }
  const member = /^([A-Z_][A-Z0-9_]*)\.(\w+)$/.exec(expression);
  if (member) {
    const objectStart = new RegExp(`^\\s*(?:export\\s+)?const ${member[1]} = \\{`, "m").exec(source);
    if (!objectStart) return null;
    const body = callArguments(source, objectStart.index + objectStart[0].length);
    const value = new RegExp(`^\\s*${member[2]}\\s*:\\s*"([^"]+)"`, "m").exec(body);
    return value ? [value[1]!] : null;
  }
  return null;
}

function scanAuditWrites(): { writes: ScannedWrite[]; unresolved: string[] } {
  const writes: ScannedWrite[] = [];
  const unresolved: string[] = [];
  for (const file of workspaceSources()) {
    const source = readFileSync(file, "utf8");
    const relative = path.relative(repoRoot, file);
    for (const match of source.matchAll(/(function\s+)?writeAuditLog\(|\.insert\(auditLog\)\s*\.values\(/g)) {
      if (match[1]) continue; // the helper's own declaration
      const args = callArguments(source, match.index + match[0].length);
      const location = `${relative}:${source.slice(0, match.index).split("\n").length}`;
      const actionExpression = propertyExpression(args, "action");
      const entityTypeExpression = propertyExpression(args, "entityType");
      if (actionExpression && WRAPPER_BODIES.has(actionExpression)) continue;
      if (!actionExpression || !entityTypeExpression) {
        unresolved.push(`${location}: no literal action/entityType property`);
        continue;
      }
      const entityTypes = resolveExpression(entityTypeExpression, source);
      const dynamic = DYNAMIC_SITES.find((site) => site.file === relative && site.actionExpression === actionExpression);
      const actions = dynamic ? dynamic.actions : resolveExpression(actionExpression, source);
      if (!entityTypes || entityTypes.length !== 1 || !actions) {
        unresolved.push(`${location}: entityType ${entityTypeExpression}, action ${actionExpression}`);
        continue;
      }
      writes.push({ location, entityType: entityTypes[0]!, actions });
    }
  }
  return { writes, unresolved };
}

const scan = scanAuditWrites();

describe("every audit_log action key in the codebase has a label", () => {
  test("the scanner finds the writers (guards against a scanner that silently matches nothing)", () => {
    expect(scan.writes.length).toBeGreaterThan(90);
    const locations = scan.writes.map((write) => write.location);
    for (const expected of ["apps/admin/src/lib/staff/mutations.ts", "apps/web/src/lib/claim/queries.ts", "packages/auth/src/customer/order-login-link-plugin.ts", "packages/commerce/src/orders/lifecycle.ts"]) {
      expect(locations.some((location) => location.startsWith(expected))).toBe(true);
    }
  });

  test("every write resolves statically (or is a listed dynamic site)", () => {
    expect(scan.unresolved).toEqual([]);
  });

  test("every (entity_type, action) written has a catalog label", () => {
    const missing = scan.writes.flatMap((write) => write.actions.filter((action) => !describeAction(write.entityType, action).known).map((action) => `${write.location}: ${write.entityType} / ${action}`));
    expect(missing).toEqual([]);
  });

  test("every dynamic site value is really passed somewhere in its package", () => {
    for (const site of DYNAMIC_SITES) {
      const packageSrc = path.join(repoRoot, site.file.split("/src/")[0]!, "src");
      const text = sourceFiles(packageSrc)
        .map((file) => readFileSync(file, "utf8"))
        .join("\n");
      for (const action of site.actions) expect(text, action).toContain(`"${action}"`);
    }
  });

  test("the catalog has no stale entries: every labelled pair is written somewhere", () => {
    const written = new Set(scan.writes.flatMap((write) => write.actions.map((action) => `${write.entityType}/${action}`)));
    const stale = Object.entries(AUDIT_CATALOG).flatMap(([entityType, type]) => Object.keys(type.actions).map((action) => `${entityType}/${action}`)).filter((pair) => !written.has(pair));
    expect(stale).toEqual([]);
  });
});

describe("no audit write the scanner cannot see", () => {
  // Forms that write audit_log without going through the two scanned shapes. Any hit must either
  // be rewritten into a scanned shape or the scanner taught about it.
  const UNSCANNED_FORMS = [/insert\(\s*\w+\.auditLog\s*\)/, /insert\s+into\s+"?audit_log/i, /writeAuditLog\s+as\s+\w/, /=\s*writeAuditLog\b(?!\()/, /\.insert\(auditLog\)(?!\s*\.values\()/];

  test("every audit_log insert goes through writeAuditLog( or .insert(auditLog).values(", () => {
    const hits = workspaceSources().flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return UNSCANNED_FORMS.filter((form) => form.test(source)).map((form) => `${path.relative(repoRoot, file)}: ${form}`);
    });
    expect(hits).toEqual([]);
  });

  test("the resolver rejects shapes it would otherwise half-read", () => {
    expect(resolveExpression('isActive ? "activate" : other', "")).toBeNull();
    expect(resolveExpression('isActive ? "activate" : "deactivate"', "")).toEqual(["activate", "deactivate"]);
    expect(propertyExpression('tx, { before: { action: "nested" }, action: "real", entityType: "x" }', "action")).toBe('"real"');
    expect(resolveExpression("KIND", 'const OTHER_KIND = "wrong";\nconst KIND = "right";')).toEqual(["right"]);
  });
});

describe("describeAction", () => {
  test("a known pair gets its Indonesian label, area and actor kind", () => {
    expect(describeAction("order", "transition_status")).toEqual({ label: "Status pesanan diubah", area: "orders", entityTypeLabel: "Pesanan", known: true, nonStaffActor: "system" });
    expect(describeAction("order", "record_refund").area).toBe("payments");
    expect(describeAction("order", "track_shipment_poll").area).toBe("shipping");
    expect(describeAction("order", "import_create").area).toBe("import");
    expect(describeAction("thank_you_card", "claim").nonStaffActor).toBe("buyer");
    expect(describeAction("order", "web_checkout").nonStaffActor).toBe("buyer");
    expect(describeAction("staff_user", "staff.role_change").label).toBe("Peran staf diganti");
  });

  test("an unknown action shows the raw key under its entity type's area, never throws", () => {
    expect(describeAction("order", "teleport")).toEqual({ label: "teleport", area: "orders", entityTypeLabel: "Pesanan", known: false, nonStaffActor: "system" });
  });

  test("an unknown entity type shows raw keys under Lainnya", () => {
    expect(describeAction("spaceship", "launch")).toEqual({ label: "launch", area: "other", entityTypeLabel: "spaceship", known: false, nonStaffActor: "system" });
  });

  test("prototype keys are not mistaken for catalog entries", () => {
    expect(describeAction("constructor", "toString")).toMatchObject({ known: false, area: "other", label: "toString" });
    expect(describeAction("order", "hasOwnProperty")).toMatchObject({ known: false, label: "hasOwnProperty" });
  });

  test("labels contain no em dash", () => {
    const labels = [...Object.values(ACTIVITY_AREAS), ...Object.values(AUDIT_CATALOG).flatMap((type) => [type.label, ...Object.values(type.actions).map((entry) => entry.label)])];
    expect(labels.filter((label) => label.includes("\u2014"))).toEqual([]);
  });

  test("isActivityArea accepts only area keys", () => {
    expect(isActivityArea("orders")).toBe(true);
    expect(isActivityArea("Pesanan")).toBe(false);
    expect(isActivityArea("toString")).toBe(false);
    expect(isActivityArea(undefined)).toBe(false);
  });
});

function inMembership(membership: AreaMembership, entityType: string, action: string): boolean {
  if (membership.entityTypes.some((entry) => entry.entityType === entityType && !entry.exceptActions.includes(action))) return true;
  if (membership.pairs.some((pair) => pair.entityType === entityType && pair.action === action)) return true;
  return membership.excludeEntityTypes !== null && !membership.excludeEntityTypes.includes(entityType);
}

describe("areaMembership (the SQL filter's data) agrees with describeAction", () => {
  const samples: [string, string][] = [
    ...Object.entries(AUDIT_CATALOG).flatMap(([entityType, type]) => Object.keys(type.actions).map((action): [string, string] => [entityType, action])),
    ["order", "some_future_action"],
    ["spaceship", "launch"],
  ];

  for (const area of Object.keys(ACTIVITY_AREAS) as ActivityArea[]) {
    test(`area ${area}`, () => {
      const membership = areaMembership(area);
      for (const [entityType, action] of samples) {
        expect(inMembership(membership, entityType, action), `${entityType}/${action}`).toBe(describeAction(entityType, action).area === area);
      }
    });
  }
});
