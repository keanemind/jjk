import * as assert from "assert";
import * as path from "path";
import { getExtensionAPI } from "./extensionApi";
import type { FileStatus } from "../repository";

suite("parseRenamePaths", () => {
  let parseRenamePaths: (
    file: string,
  ) => { fromPath: string; toPath: string } | null;

  suiteSetup(async () => {
    ({ parseRenamePaths } = (await getExtensionAPI()).repository);
  });

  test("should handle rename with no prefix or suffix", () => {
    const input = "{old => new}";
    const expected = {
      fromPath: "old",
      toPath: "new",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should handle rename with only suffix", () => {
    const input = "{old => new}.txt";
    const expected = {
      fromPath: "old.txt",
      toPath: "new.txt",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should handle rename with only prefix", () => {
    const input = "prefix/{old => new}";
    const expected = {
      fromPath: "prefix/old",
      toPath: "prefix/new",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should handle empty fromPart", () => {
    const input = "src/test/{ => basic-suite}/main.test.ts";
    const expected = {
      fromPath: "src/test/main.test.ts",
      toPath: "src/test/basic-suite/main.test.ts",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should handle empty toPart", () => {
    const input = "src/{old => }/file.ts";
    const expected = {
      fromPath: "src/old/file.ts",
      toPath: "src/file.ts",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should parse rename with leading and trailing directories", () => {
    const input = "a/b/{c => d}/e/f.txt";
    const expected = {
      fromPath: "a/b/c/e/f.txt",
      toPath: "a/b/d/e/f.txt",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should handle extra spaces within curly braces", () => {
    const input = "src/test/{  =>   basic-suite  }/main.test.ts";
    const expected = {
      fromPath: "src/test/main.test.ts",
      toPath: "src/test/basic-suite/main.test.ts",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should handle paths with dots in segments", () => {
    const input = "src/my.component/{old.module => new.module}/index.ts";
    const expected = {
      fromPath: "src/my.component/old.module/index.ts",
      toPath: "src/my.component/new.module/index.ts",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should handle paths with spaces", () => {
    // This test depends on how robust the regex is to special path characters.
    // The current regex is simple and might fail with complex characters.
    const input = "src folder/{a b => c d}/file name with spaces.txt";
    const expected = {
      fromPath: "src folder/a b/file name with spaces.txt",
      toPath: "src folder/c d/file name with spaces.txt",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test("should return null for simple rename without curly braces", () => {
    const input = "old.txt => new.txt";
    assert.strictEqual(parseRenamePaths(input), null);
  });

  test("should return null for non-rename lines", () => {
    const input = "M src/some/file.ts";
    assert.strictEqual(parseRenamePaths(input), null);
  });

  test("should return null for empty input", () => {
    const input = "";
    assert.strictEqual(parseRenamePaths(input), null);
  });
});

suite("parseFileStatusLine", () => {
  let parseFileStatusLine: (
    repositoryRoot: string,
    line: string,
    out: FileStatus[],
  ) => boolean;

  const root = "/repo";

  suiteSetup(async () => {
    ({ parseFileStatusLine } = (await getExtensionAPI()).repository);
  });

  test("parses added file", () => {
    const out: FileStatus[] = [];
    assert.strictEqual(parseFileStatusLine(root, "A src/new.ts", out), true);
    assert.deepStrictEqual(out, [
      { type: "A", file: "src/new.ts", path: path.join(root, "src/new.ts") },
    ]);
  });

  test("parses modified file", () => {
    const out: FileStatus[] = [];
    parseFileStatusLine(root, "M lib/utils.ts", out);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].type, "M");
    assert.strictEqual(out[0].file, "lib/utils.ts");
  });

  test("parses deleted file", () => {
    const out: FileStatus[] = [];
    parseFileStatusLine(root, "D old-file.txt", out);
    assert.strictEqual(out[0].type, "D");
  });

  test("parses rename with brace syntax", () => {
    const out: FileStatus[] = [];
    parseFileStatusLine(root, "R src/{old => new}/file.ts", out);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].type, "R");
    assert.strictEqual(out[0].file, "src/new/file.ts");
    assert.strictEqual(out[0].renamedFrom, "src/old/file.ts");
  });

  test("parses copy", () => {
    const out: FileStatus[] = [];
    parseFileStatusLine(root, "C src/{a => b}.ts", out);
    assert.strictEqual(out[0].type, "C");
    assert.strictEqual(out[0].renamedFrom, "src/a.ts");
  });

  test("returns false for non-matching line", () => {
    const out: FileStatus[] = [];
    assert.strictEqual(
      parseFileStatusLine(root, "Working copy : abc123", out),
      false,
    );
    assert.strictEqual(out.length, 0);
  });

  test("returns false for empty line", () => {
    const out: FileStatus[] = [];
    assert.strictEqual(parseFileStatusLine(root, "", out), false);
  });

  test("appends to existing array", () => {
    const out: FileStatus[] = [
      { type: "A", file: "existing.ts", path: path.join(root, "existing.ts") },
    ];
    parseFileStatusLine(root, "M second.ts", out);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[1].type, "M");
  });
});
