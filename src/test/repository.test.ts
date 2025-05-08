import * as assert from "assert";
import { parseRenamePaths } from "../repository"; // Adjust path as needed

describe("parseRenamePaths", () => {
  it("should parse basic-suite rename correctly", () => {
    const input = "src/test/{ => basic-suite}/main.test.ts";
    const expected = {
      fromPath: "src/test/main.test.ts",
      toPath: "src/test/basic-suite/main.test.ts",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  it("should parse rename with leading directory", () => {
    const input = "foo/{bar => baz}/qux.txt";
    const expected = {
      fromPath: "foo/bar/qux.txt",
      toPath: "foo/baz/qux.txt",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  it("should parse rename with trailing directory", () => {
    const input = "foo/bar/{baz => quux}/corge.txt";
    const expected = {
      fromPath: "foo/bar/baz/corge.txt",
      toPath: "foo/bar/quux/corge.txt",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  it("should parse rename with both leading and trailing directories", () => {
    const input = "a/b/{c => d}/e/f.txt";
    const expected = {
      fromPath: "a/b/c/e/f.txt",
      toPath: "a/b/d/e/f.txt",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  it("should return null for simple rename without curly braces", () => {
    const input = "old.txt => new.txt";
    assert.strictEqual(parseRenamePaths(input), null);
  });

  it("should handle extra spaces within curly braces", () => {
    const input = "src/test/{  =>   basic-suite  }/main.test.ts";
    const expected = {
      fromPath: "src/test/main.test.ts",
      toPath: "src/test/basic-suite/main.test.ts",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  it("should handle non-empty fromPart", () => {
    const input = "src/{old-dir => new-dir}/file.ts";
    const expected = {
      fromPath: "src/old-dir/file.ts",
      toPath: "src/new-dir/file.ts",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  it("should handle rename with only suffix", () => {
    const input = "{old => new}.txt";
    const expected = {
      fromPath: "old.txt",
      toPath: "new.txt",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  it("should handle rename with only prefix", () => {
    const input = "prefix/{old => new}";
    const expected = {
      fromPath: "prefix/old",
      toPath: "prefix/new",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  it("should handle rename with no prefix or suffix", () => {
    const input = "{old => new}";
    const expected = {
      fromPath: "old",
      toPath: "new",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  it("should return null for non-rename lines", () => {
    const input = "M src/some/file.ts";
    assert.strictEqual(parseRenamePaths(input), null);
  });

  it("should return null for empty input", () => {
    const input = "";
    assert.strictEqual(parseRenamePaths(input), null);
  });

  it("should handle paths with dots in segments", () => {
    const input = "src/my.component/{old.module => new.module}/index.ts";
    const expected = {
      fromPath: "src/my.component/old.module/index.ts",
      toPath: "src/my.component/new.module/index.ts",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  it("should handle paths with special characters if regex allows (current regex might not)", () => {
    // This test depends on how robust the regex is to special path characters.
    // The current regex is simple and might fail with complex characters.
    const input = "src/{a b => c d}/file name with spaces.txt";
    const expected = {
      fromPath: "src/a b/file name with spaces.txt",
      toPath: "src/c d/file name with spaces.txt",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  it("should handle fromPart with spaces", () => {
    const input = "src/{old dir name => new-dir}/file.ts";
    const expected = {
      fromPath: "src/old dir name/file.ts",
      toPath: "src/new-dir/file.ts",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  it("should handle toPart with spaces", () => {
    const input = "src/{old-dir => new dir name}/file.ts";
    const expected = {
      fromPath: "src/old-dir/file.ts",
      toPath: "src/new dir name/file.ts",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  it("should handle prefix and suffix with spaces (if path segments can have spaces)", () => {
    const input = "my folder/{old => new}/my file.txt";
    const expected = {
      fromPath: "my folder/old/my file.txt",
      toPath: "my folder/new/my file.txt",
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });
});
