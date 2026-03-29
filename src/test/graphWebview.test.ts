import * as assert from "assert";
import { getExtensionAPI } from "./extensionApi";
import type { ChangeNode } from "../graphWebview";

suite("parseJJLog", () => {
  let parseJJLog: typeof import("../graphWebview").parseJJLog;

  suiteSetup(async () => {
    ({ parseJJLog } = (await getExtensionAPI()).graphWebview);
  });

  test("parses graph rows into structured change nodes", () => {
    const output = `@  xwqpumyo joshka@users.noreply.github.com 2026-03-26 13:18:29 132eedbf
│  (empty) Match graph metadata to jj log
│ ○  prrwzkws joshka@users.noreply.github.com 2026-03-26 12:58:52 joshka/discard-confirmation-safety 21d41297
│ │  Do not restore copy sources
◆  ysouttnr email@example.com 2026-03-23 16:50:41 main 0dc3706d
│  fix lint errors introduced by the new rule in the rest of the tests (#222)
◆  zzzzzzzz root() 00000000
~  (elided revisions)
`;

    const nodes = parseJJLog(output);

    assert.strictEqual(nodes.length, 5);

    const expecteds = [
      {
        branchType: "@",
        changeId: "xwqpumyo",
        commitId: "132eedbf",
        author: "joshka@users.noreply.github.com",
        authorDisplay: "joshka",
        refName: "",
        description: "Match graph metadata to jj log",
        hasDescription: true,
        isEmpty: true,
        isElided: false,
      },
      {
        branchType: "○",
        changeId: "prrwzkws",
        commitId: "21d41297",
        author: "joshka@users.noreply.github.com",
        authorDisplay: "joshka",
        refName: "joshka/discard-confirmation-safety",
        description: "Do not restore copy sources",
        hasDescription: true,
        isEmpty: false,
        isElided: false,
      },
      {
        branchType: "◆",
        changeId: "ysouttnr",
        commitId: "0dc3706d",
        author: "email@example.com",
        authorDisplay: "email",
        refName: "main",
        description:
          "fix lint errors introduced by the new rule in the rest of the tests (#222)",
        hasDescription: true,
        isEmpty: false,
        isElided: false,
      },
      {
        branchType: "◆",
        changeId: "zzzzzzzz",
        commitId: "00000000",
        author: "",
        authorDisplay: "",
        refName: "root()",
        description: "", // root is a special case where we don't display (no description set)
        hasDescription: false,
        isEmpty: false,
        isElided: false,
      },
      {
        branchType: "~",
        changeId: "",
        commitId: "",
        author: "",
        authorDisplay: "",
        refName: "",
        description: "Older revisions hidden",
        hasDescription: false,
        isEmpty: false,
        isElided: true,
      },
    ] satisfies Partial<ChangeNode>[];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const expected = expecteds[i];
      if (i === 3) {
        console.log(
          JSON.stringify({
            branchType: node.branchType,
            changeId: node.changeId,
            commitId: node.commitId,
            author: node.author,
            authorDisplay: node.authorDisplay,
            refName: node.refName,
            description: node.description,
            hasDescription: node.hasDescription,
            isEmpty: node.isEmpty,
            isElided: node.isElided,
          }),
        );
      }
      assert.deepStrictEqual(
        {
          branchType: node.branchType,
          changeId: node.changeId,
          commitId: node.commitId,
          author: node.author,
          authorDisplay: node.authorDisplay,
          refName: node.refName,
          description: node.description,
          hasDescription: node.hasDescription,
          isEmpty: node.isEmpty,
          isElided: node.isElided,
        } satisfies Partial<ChangeNode>,
        expected,
        `Node ${i} does not match expected`,
      );
    }
  });

  test("tracks jj graph columns for branch layout", () => {
    const output = `@  qpvpxzmt joshka@users.noreply.github.com 2026-03-26 13:27:12 574832b7
│  (empty) (no description set)
│ ○  wmrswpmr joshka@users.noreply.github.com 2026-03-26 12:24:12 e76a6182
│ │  asdf
│ ○  vmqtxuzp joshka@users.noreply.github.com 2026-01-04 02:20:35 b44ffdf3
│ │  (empty) (no description set)
│ ○  loosuqzx joshka@users.noreply.github.com 2026-01-04 01:54:37 17662276
├─╯  (empty) bump version to 0.7.0
○  skkurnom joshka@users.noreply.github.com 2025-07-22 14:40:09 contrib 441b7bd6
│  Contrib.md
◆  zzzzzzzz root() 00000000
`;

    const nodes = parseJJLog(output);
    const columns = Object.fromEntries(
      nodes.map((node) => [node.changeId || "~", node.symbolColumn]),
    );

    assert.deepStrictEqual(columns, {
      qpvpxzmt: 0,
      wmrswpmr: 2,
      vmqtxuzp: 2,
      loosuqzx: 2,
      skkurnom: 0,
      zzzzzzzz: 0,
    });
  });

  test("reports missing descriptions distinctly from empty changes", () => {
    const output = `@  nxxvmutx joshka@users.noreply.github.com 2026-03-26 12:58:52 eaf68a4c
│  (empty) (no description set)
`;

    const [node] = parseJJLog(output);

    assert.ok(node);
    assert.strictEqual(node.isEmpty, true);
    assert.strictEqual(node.hasDescription, false);
    assert.strictEqual(node.description, "(no description set)");
  });

  test("parses conflicted changes", () => {
    const output = `@  nwwlprqr email@example.com 2026-03-28 03:31:26 jjk-ws-1@ e8b9a26d (conflict)
│  (empty) (no description set)
×    ysqrxsnm email@example.com 2026-03-19 21:53:44 197d5812 (conflict)
├─╮  more testing
○ │  qtoqzoqk email@example.com 2026-03-19 21:53:44 f305fe54
│ │  (empty) (no description set)
`;

    const nodes = parseJJLog(output);

    assert.strictEqual(nodes.length, 3);

    assert.strictEqual(nodes[0].changeId, "nwwlprqr");
    assert.strictEqual(nodes[0].isConflict, true);
    assert.strictEqual(nodes[0].commitId, "e8b9a26d");
    assert.strictEqual(nodes[0].branchType, "@");

    assert.strictEqual(nodes[1].changeId, "ysqrxsnm");
    assert.strictEqual(nodes[1].isConflict, true);
    assert.strictEqual(nodes[1].commitId, "197d5812");

    assert.strictEqual(nodes[2].changeId, "qtoqzoqk");
    assert.strictEqual(nodes[2].isConflict, false);
    assert.strictEqual(nodes[2].commitId, "f305fe54");
  });

  test("preserves the full multi-line description for hover details", () => {
    const output = `@  nxxvmutx joshka@users.noreply.github.com 2026-03-26 12:58:52 eaf68a4c
│  Add graph popup
│
│  Keep the row compact.
│  Show the body only in the hover.
`;

    const [node] = parseJJLog(output);

    assert.ok(node);
    assert.strictEqual(node.description, "Add graph popup");
    assert.strictEqual(
      node.fullDescription,
      "Add graph popup\n\nKeep the row compact.\nShow the body only in the hover.",
    );
  });
});
