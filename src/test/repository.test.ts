import * as assert from "assert";
import { getExtensionAPI } from "./extensionApi";

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

suite("getRestorePaths", () => {
  let getRestorePaths: (
    statuses: {
      type: "A" | "M" | "D" | "R" | "C";
      file: string;
      path: string;
      renamedFrom?: string;
    }[],
  ) => string[];

  suiteSetup(async () => {
    ({ getRestorePaths } = (await getExtensionAPI()).repository);
  });

  test("restores only the selected path for normal file changes", () => {
    assert.deepStrictEqual(
      getRestorePaths([{ type: "M", file: "file.ts", path: "file.ts" }]),
      ["file.ts"],
    );
  });

  test("restores both sides of a rename", () => {
    assert.deepStrictEqual(
      getRestorePaths([
        {
          type: "R",
          file: "new.ts",
          path: "new.ts",
          renamedFrom: "old.ts",
        },
      ]),
      ["new.ts", "old.ts"],
    );
  });

  test("does not restore the source side of a copy", () => {
    assert.deepStrictEqual(
      getRestorePaths([
        {
          type: "C",
          file: "copy.ts",
          path: "copy.ts",
          renamedFrom: "source.ts",
        },
      ]),
      ["copy.ts"],
    );
  });
});
