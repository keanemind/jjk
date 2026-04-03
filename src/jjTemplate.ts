// ---- Internal AST ----

type Node =
  | { kind: "keyword"; name: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "string"; value: string }
  | { kind: "concat"; parts: Node[] }
  | { kind: "methodCall"; target: Node; method: string; args: Node[] }
  | { kind: "functionCall"; name: string; args: Node[] }
  | { kind: "lambda"; param: string; body: Node }
  | { kind: "not"; operand: Node }
  | { kind: "binOp"; op: "&&" | "||" | "==" | "!="; left: Node; right: Node }
  | { kind: "raw"; text: string };

function escapeString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\0/g, "\\0")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function needsParens(node: Node): boolean {
  return node.kind === "binOp" || node.kind === "concat";
}

function serialize(node: Node): string {
  switch (node.kind) {
    case "keyword":
      return node.name;
    case "boolean":
      return node.value ? "true" : "false";
    case "string":
      return `"${escapeString(node.value)}"`;
    case "concat":
      return node.parts.map(serialize).join(" ++ ");
    case "methodCall": {
      const args = node.args.map(serialize).join(", ");
      return `${serialize(node.target)}.${node.method}(${args})`;
    }
    case "functionCall": {
      const args = node.args.map(serialize).join(", ");
      return `${node.name}(${args})`;
    }
    case "lambda":
      return `|${node.param}| ${serialize(node.body)}`;
    case "not": {
      const operand = serialize(node.operand);
      return needsParens(node.operand) ? `!(${operand})` : `!${operand}`;
    }
    case "binOp": {
      const l = needsParens(node.left)
        ? `(${serialize(node.left)})`
        : serialize(node.left);
      const r = needsParens(node.right)
        ? `(${serialize(node.right)})`
        : serialize(node.right);
      return `${l} ${node.op} ${r}`;
    }
    case "raw":
      return node.text;
  }
}

/** Shorthand for creating a method call node */
function mc(target: Node, method: string, ...args: Node[]): Node {
  return { kind: "methodCall", target, method, args };
}

// ---- Base expression ----

export class Expr {
  /** @internal */
  readonly node: Node;

  constructor(node: Node) {
    this.node = node;
  }

  /** Template concatenation: `this ++ a ++ b` */
  concat(...parts: Expr[]): Expr {
    return new Expr({
      kind: "concat",
      parts: [this.node, ...parts.map((p) => p.node)],
    });
  }

  not(): BooleanExpr {
    return new BooleanExpr({ kind: "not", operand: this.node });
  }
  and(other: Expr): BooleanExpr {
    return new BooleanExpr({
      kind: "binOp",
      op: "&&",
      left: this.node,
      right: other.node,
    });
  }
  or(other: Expr): BooleanExpr {
    return new BooleanExpr({
      kind: "binOp",
      op: "||",
      left: this.node,
      right: other.node,
    });
  }
  eq(other: Expr): BooleanExpr {
    return new BooleanExpr({
      kind: "binOp",
      op: "==",
      left: this.node,
      right: other.node,
    });
  }
  neq(other: Expr): BooleanExpr {
    return new BooleanExpr({
      kind: "binOp",
      op: "!=",
      left: this.node,
      right: other.node,
    });
  }

  /** Serialize to a jj template string */
  build(): string {
    return serialize(this.node);
  }
}

// ---- Scalar types ----

export class BooleanExpr extends Expr { }
export class IntegerExpr extends Expr { }

export class StringExpr extends Expr {
  len(): IntegerExpr {
    return new IntegerExpr(mc(this.node, "len"));
  }
  contains(needle: StringExpr): BooleanExpr {
    return new BooleanExpr(mc(this.node, "contains", needle.node));
  }
  first_line(): StringExpr {
    return new StringExpr(mc(this.node, "first_line"));
  }
  lines(): ListExpr<StringExpr> {
    return new ListExpr(mc(this.node, "lines"), (n) => new StringExpr(n));
  }
  upper(): StringExpr {
    return new StringExpr(mc(this.node, "upper"));
  }
  lower(): StringExpr {
    return new StringExpr(mc(this.node, "lower"));
  }
  starts_with(prefix: StringExpr): BooleanExpr {
    return new BooleanExpr(mc(this.node, "starts_with", prefix.node));
  }
  ends_with(suffix: StringExpr): BooleanExpr {
    return new BooleanExpr(mc(this.node, "ends_with", suffix.node));
  }
  trim(): StringExpr {
    return new StringExpr(mc(this.node, "trim"));
  }
  trim_start(): StringExpr {
    return new StringExpr(mc(this.node, "trim_start"));
  }
  trim_end(): StringExpr {
    return new StringExpr(mc(this.node, "trim_end"));
  }
  escape_json(): StringExpr {
    return new StringExpr(mc(this.node, "escape_json"));
  }
  substr(start: Expr, end?: Expr): StringExpr {
    return new StringExpr(
      end
        ? mc(this.node, "substr", start.node, end.node)
        : mc(this.node, "substr", start.node),
    );
  }
  split(delimiter: StringExpr): ListExpr<StringExpr> {
    return new ListExpr(
      mc(this.node, "split", delimiter.node),
      (n) => new StringExpr(n),
    );
  }
  replace(from: StringExpr, to: StringExpr): StringExpr {
    return new StringExpr(mc(this.node, "replace", from.node, to.node));
  }
  match(pattern: StringExpr): BooleanExpr {
    return new BooleanExpr(mc(this.node, "match", pattern.node));
  }
}

// ---- ID types ----

export class ChangeIdExpr extends Expr {
  short(len?: Expr): StringExpr {
    return new StringExpr(
      len ? mc(this.node, "short", len.node) : mc(this.node, "short"),
    );
  }
  shortest(len?: Expr): StringExpr {
    return new StringExpr(
      len ? mc(this.node, "shortest", len.node) : mc(this.node, "shortest"),
    );
  }
  normal_hex(): StringExpr {
    return new StringExpr(mc(this.node, "normal_hex"));
  }
}

export class CommitIdExpr extends Expr {
  short(len?: Expr): StringExpr {
    return new StringExpr(
      len ? mc(this.node, "short", len.node) : mc(this.node, "short"),
    );
  }
  shortest(len?: Expr): StringExpr {
    return new StringExpr(
      len ? mc(this.node, "shortest", len.node) : mc(this.node, "shortest"),
    );
  }
}

export class OperationIdExpr extends Expr {
  short(len?: Expr): StringExpr {
    return new StringExpr(
      len ? mc(this.node, "short", len.node) : mc(this.node, "short"),
    );
  }
}

// ---- Signature types ----

export class SignatureExpr extends Expr {
  name(): StringExpr {
    return new StringExpr(mc(this.node, "name"));
  }
  email(): EmailExpr {
    return new EmailExpr(mc(this.node, "email"));
  }
  timestamp(): TimestampExpr {
    return new TimestampExpr(mc(this.node, "timestamp"));
  }
}

export class EmailExpr extends Expr {
  local(): StringExpr {
    return new StringExpr(mc(this.node, "local"));
  }
  domain(): StringExpr {
    return new StringExpr(mc(this.node, "domain"));
  }
}

// ---- Time types ----

export class TimestampExpr extends Expr {
  ago(): StringExpr {
    return new StringExpr(mc(this.node, "ago"));
  }
  format(fmt: StringExpr): StringExpr {
    return new StringExpr(mc(this.node, "format", fmt.node));
  }
  local(): TimestampExpr {
    return new TimestampExpr(mc(this.node, "local"));
  }
  utc(): TimestampExpr {
    return new TimestampExpr(mc(this.node, "utc"));
  }
  after(other: TimestampExpr): BooleanExpr {
    return new BooleanExpr(mc(this.node, "after", other.node));
  }
  before(other: TimestampExpr): BooleanExpr {
    return new BooleanExpr(mc(this.node, "before", other.node));
  }
  since(other: TimestampExpr): TimestampRangeExpr {
    return new TimestampRangeExpr(mc(this.node, "since", other.node));
  }
}

export class TimestampRangeExpr extends Expr {
  start(): TimestampExpr {
    return new TimestampExpr(mc(this.node, "start"));
  }
  end(): TimestampExpr {
    return new TimestampExpr(mc(this.node, "end"));
  }
  duration(): StringExpr {
    return new StringExpr(mc(this.node, "duration"));
  }
}

// ---- Diff types ----

export class TreeDiffExpr extends Expr {
  files(): ListExpr<TreeDiffEntryExpr> {
    return new ListExpr(
      mc(this.node, "files"),
      (n) => new TreeDiffEntryExpr(n),
    );
  }
  color_words(): Expr {
    return new Expr(mc(this.node, "color_words"));
  }
  git(): Expr {
    return new Expr(mc(this.node, "git"));
  }
  stat(): DiffStatsExpr {
    return new DiffStatsExpr(mc(this.node, "stat"));
  }
  summary(): Expr {
    return new Expr(mc(this.node, "summary"));
  }
}

export class TreeDiffEntryExpr extends Expr {
  path(): RepoPathExpr {
    return new RepoPathExpr(mc(this.node, "path"));
  }
  display_diff_path(): StringExpr {
    return new StringExpr(mc(this.node, "display_diff_path"));
  }
  status(): StringExpr {
    return new StringExpr(mc(this.node, "status"));
  }
  status_char(): StringExpr {
    return new StringExpr(mc(this.node, "status_char"));
  }
  source(): TreeDiffSideExpr {
    return new TreeDiffSideExpr(mc(this.node, "source"));
  }
  target(): TreeDiffSideExpr {
    return new TreeDiffSideExpr(mc(this.node, "target"));
  }
}

export class TreeDiffSideExpr extends Expr {
  path(): RepoPathExpr {
    return new RepoPathExpr(mc(this.node, "path"));
  }
  conflict(): BooleanExpr {
    return new BooleanExpr(mc(this.node, "conflict"));
  }
}

export class DiffStatsExpr extends Expr {
  files(): ListExpr<StringExpr> {
    return new ListExpr(mc(this.node, "files"), (n) => new StringExpr(n));
  }
  total_added(): IntegerExpr {
    return new IntegerExpr(mc(this.node, "total_added"));
  }
  total_removed(): IntegerExpr {
    return new IntegerExpr(mc(this.node, "total_removed"));
  }
}

// ---- Path type ----

export class RepoPathExpr extends Expr {
  absolute(): StringExpr {
    return new StringExpr(mc(this.node, "absolute"));
  }
  display(): StringExpr {
    return new StringExpr(mc(this.node, "display"));
  }
  parent(): RepoPathExpr {
    return new RepoPathExpr(mc(this.node, "parent"));
  }
}

// ---- Ref types ----

export class CommitRefExpr extends Expr {
  name(): StringExpr {
    return new StringExpr(mc(this.node, "name"));
  }
  remote(): StringExpr {
    return new StringExpr(mc(this.node, "remote"));
  }
  present(): BooleanExpr {
    return new BooleanExpr(mc(this.node, "present"));
  }
  conflict(): BooleanExpr {
    return new BooleanExpr(mc(this.node, "conflict"));
  }
  normal_target(): CommitT {
    return new CommitT(mc(this.node, "normal_target"));
  }
  removed_targets(): ListExpr<CommitT> {
    return new ListExpr(
      mc(this.node, "removed_targets"),
      (n) => new CommitT(n),
    );
  }
  added_targets(): ListExpr<CommitT> {
    return new ListExpr(
      mc(this.node, "added_targets"),
      (n) => new CommitT(n),
    );
  }
  tracked(): BooleanExpr {
    return new BooleanExpr(mc(this.node, "tracked"));
  }
  tracking_present(): BooleanExpr {
    return new BooleanExpr(mc(this.node, "tracking_present"));
  }
  tracking_remote(): StringExpr {
    return new StringExpr(mc(this.node, "tracking_remote"));
  }
}

export class CryptographicSignatureExpr extends Expr {
  status(): StringExpr {
    return new StringExpr(mc(this.node, "status"));
  }
  key(): StringExpr {
    return new StringExpr(mc(this.node, "key"));
  }
  display(): StringExpr {
    return new StringExpr(mc(this.node, "display"));
  }
}

export class TrailerExpr extends Expr {
  key(): StringExpr {
    return new StringExpr(mc(this.node, "key"));
  }
  value(): StringExpr {
    return new StringExpr(mc(this.node, "value"));
  }
}

export class WorkspaceRefExpr extends Expr {
  name(): StringExpr {
    return new StringExpr(mc(this.node, "name"));
  }
  target(): CommitT {
    return new CommitT(mc(this.node, "target"));
  }
  root(): RepoPathExpr {
    return new RepoPathExpr(mc(this.node, "root"));
  }
}

// ---- List<T> ----

export class ListExpr<T extends Expr> extends Expr {
  private elementFactory: (n: Node) => T;

  constructor(node: Node, elementFactory: (n: Node) => T) {
    super(node);
    this.elementFactory = elementFactory;
  }

  map(param: string, callback: (bound: T) => Expr): ListExpr<Expr> {
    const bound = this.elementFactory({ kind: "keyword", name: param });
    const body = callback(bound);
    return new ListExpr(
      mc(this.node, "map", { kind: "lambda", param, body: body.node }),
      (n) => new Expr(n),
    );
  }

  filter(param: string, callback: (bound: T) => Expr): ListExpr<T> {
    const bound = this.elementFactory({ kind: "keyword", name: param });
    const body = callback(bound);
    return new ListExpr(
      mc(this.node, "filter", { kind: "lambda", param, body: body.node }),
      this.elementFactory,
    );
  }

  join(separator: string): StringExpr {
    return new StringExpr(
      mc(this.node, "join", { kind: "string", value: separator }),
    );
  }

  any(param: string, callback: (bound: T) => Expr): BooleanExpr {
    const bound = this.elementFactory({ kind: "keyword", name: param });
    const body = callback(bound);
    return new BooleanExpr(
      mc(this.node, "any", { kind: "lambda", param, body: body.node }),
    );
  }

  all(param: string, callback: (bound: T) => Expr): BooleanExpr {
    const bound = this.elementFactory({ kind: "keyword", name: param });
    const body = callback(bound);
    return new BooleanExpr(
      mc(this.node, "all", { kind: "lambda", param, body: body.node }),
    );
  }

  first(): T {
    return this.elementFactory(mc(this.node, "first"));
  }
  last(): T {
    return this.elementFactory(mc(this.node, "last"));
  }
  get(index: Expr): T {
    return this.elementFactory(mc(this.node, "get", index.node));
  }
  len(): IntegerExpr {
    return new IntegerExpr(mc(this.node, "len"));
  }
  reverse(): ListExpr<T> {
    return new ListExpr(mc(this.node, "reverse"), this.elementFactory);
  }
  skip(count: Expr): ListExpr<T> {
    return new ListExpr(
      mc(this.node, "skip", count.node),
      this.elementFactory,
    );
  }
  take(count: Expr): ListExpr<T> {
    return new ListExpr(
      mc(this.node, "take", count.node),
      this.elementFactory,
    );
  }
}

// ---- Context types ----

export class CommitT extends Expr {
  constructor(node: Node = { kind: "keyword", name: "self" }) {
    super(node);
  }

  change_id(): ChangeIdExpr {
    return new ChangeIdExpr(mc(this.node, "change_id"));
  }
  commit_id(): CommitIdExpr {
    return new CommitIdExpr(mc(this.node, "commit_id"));
  }
  author(): SignatureExpr {
    return new SignatureExpr(mc(this.node, "author"));
  }
  committer(): SignatureExpr {
    return new SignatureExpr(mc(this.node, "committer"));
  }
  description(): StringExpr {
    return new StringExpr(mc(this.node, "description"));
  }
  parents(): ListExpr<CommitT> {
    return new ListExpr(mc(this.node, "parents"), (n) => new CommitT(n));
  }
  empty(): BooleanExpr {
    return new BooleanExpr(mc(this.node, "empty"));
  }
  conflict(): BooleanExpr {
    return new BooleanExpr(mc(this.node, "conflict"));
  }
  diff(): TreeDiffExpr {
    return new TreeDiffExpr(mc(this.node, "diff"));
  }
  bookmarks(): ListExpr<CommitRefExpr> {
    return new ListExpr(
      mc(this.node, "bookmarks"),
      (n) => new CommitRefExpr(n),
    );
  }
  local_bookmarks(): ListExpr<CommitRefExpr> {
    return new ListExpr(
      mc(this.node, "local_bookmarks"),
      (n) => new CommitRefExpr(n),
    );
  }
  remote_bookmarks(): ListExpr<CommitRefExpr> {
    return new ListExpr(
      mc(this.node, "remote_bookmarks"),
      (n) => new CommitRefExpr(n),
    );
  }
  tags(): ListExpr<CommitRefExpr> {
    return new ListExpr(mc(this.node, "tags"), (n) => new CommitRefExpr(n));
  }
  working_copies(): ListExpr<WorkspaceRefExpr> {
    return new ListExpr(
      mc(this.node, "working_copies"),
      (n) => new WorkspaceRefExpr(n),
    );
  }
  root(): BooleanExpr {
    return new BooleanExpr(mc(this.node, "root"));
  }
  immutable(): BooleanExpr {
    return new BooleanExpr(mc(this.node, "immutable"));
  }
  mine(): BooleanExpr {
    return new BooleanExpr(mc(this.node, "mine"));
  }
  hidden(): BooleanExpr {
    return new BooleanExpr(mc(this.node, "hidden"));
  }
  trailers(): ListExpr<TrailerExpr> {
    return new ListExpr(mc(this.node, "trailers"), (n) => new TrailerExpr(n));
  }
  signature(): CryptographicSignatureExpr {
    return new CryptographicSignatureExpr(mc(this.node, "signature"));
  }
}

export class OperationT extends Expr {
  constructor(node: Node = { kind: "keyword", name: "self" }) {
    super(node);
  }

  id(): OperationIdExpr {
    return new OperationIdExpr(mc(this.node, "id"));
  }
  description(): StringExpr {
    return new StringExpr(mc(this.node, "description"));
  }
  tags(): StringExpr {
    return new StringExpr(mc(this.node, "tags"));
  }
  time(): TimestampRangeExpr {
    return new TimestampRangeExpr(mc(this.node, "time"));
  }
  user(): StringExpr {
    return new StringExpr(mc(this.node, "user"));
  }
  snapshot(): BooleanExpr {
    return new BooleanExpr(mc(this.node, "snapshot"));
  }
  current_operation(): BooleanExpr {
    return new BooleanExpr(mc(this.node, "current_operation"));
  }
}

// ---- Top-level factories ----

/** Double-quoted string literal with automatic escaping */
export function str(value: string): StringExpr {
  return new StringExpr({ kind: "string", value });
}

/** Boolean literal */
export function bool(value: boolean): BooleanExpr {
  return new BooleanExpr({ kind: "boolean", value });
}

/** Template concatenation: `a ++ b ++ c` */
export function concat(...parts: Expr[]): Expr {
  return new Expr({ kind: "concat", parts: parts.map((p) => p.node) });
}

/** Raw template text (escape hatch) */
export function raw(text: string): Expr {
  return new Expr({ kind: "raw", text });
}

// ---- Global functions ----

/** `stringify(x)` — converts to string, stripping color labels */
export function stringify(arg: Expr): StringExpr {
  return new StringExpr({
    kind: "functionCall",
    name: "stringify",
    args: [arg.node],
  });
}

/** `if(condition, then, else)` */
export function jjIf(cond: Expr, then_: Expr, else_: Expr): Expr {
  return new Expr({
    kind: "functionCall",
    name: "if",
    args: [cond.node, then_.node, else_.node],
  });
}

/** `label(label_name, content)` */
export function label(labelExpr: StringExpr, content: Expr): Expr {
  return new Expr({
    kind: "functionCall",
    name: "label",
    args: [labelExpr.node, content.node],
  });
}

// ---- Record template builder ----

export interface RecordTemplate {
  template: string;
  fieldSeparator: string;
  recordSeparator: string;
  startSentinel?: string;
  fields: { name: string; expr: Expr }[];
}

interface RecordTemplateConfig {
  fieldSeparator: string;
  recordSeparator: string;
  startSentinel?: string;
}

export class RecordTemplateBuilder {
  private constructor(
    private config: RecordTemplateConfig,
    private _fields: { name: string; expr: Expr }[],
  ) { }

  static create(config: RecordTemplateConfig): RecordTemplateBuilder {
    return new RecordTemplateBuilder(config, []);
  }

  field(name: string, expr: Expr): RecordTemplateBuilder {
    return new RecordTemplateBuilder(this.config, [
      ...this._fields,
      { name, expr },
    ]);
  }

  build(): RecordTemplate {
    const parts: Node[] = [];

    if (this.config.startSentinel) {
      parts.push({ kind: "string", value: this.config.startSentinel });
    }

    for (let i = 0; i < this._fields.length; i++) {
      if (i > 0) {
        parts.push({ kind: "string", value: this.config.fieldSeparator });
      }
      parts.push(this._fields[i].expr.node);
    }
    parts.push({ kind: "string", value: this.config.recordSeparator });

    return {
      template: serialize({ kind: "concat", parts }),
      fieldSeparator: this.config.fieldSeparator,
      recordSeparator: this.config.recordSeparator,
      startSentinel: this.config.startSentinel,
      fields: this._fields,
    };
  }
}

/** Create a record template builder */
export function template(config: RecordTemplateConfig): RecordTemplateBuilder {
  return RecordTemplateBuilder.create(config);
}
