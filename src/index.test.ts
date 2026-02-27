import { describe, it, expect } from "vitest";
import { virtualShell, type VFile } from "./index";

const FILES: VFile[] = [
  { path: "README.md", content: "# Hello\n\nThis is a test project.\n" },
  { path: "src/index.ts", content: 'export const name = "convex-shell";\nexport const version = "0.1.0";\n' },
  { path: "src/utils.ts", content: "export function add(a: number, b: number) {\n  return a + b;\n}\n" },
  { path: "config/settings.yml", content: "app:\n  name: test\n  debug: true\n" },
  { path: "config/routes.yml", content: "routes:\n  - path: /api\n    handler: api\n" },
];

describe("virtualShell", () => {
  describe("cat", () => {
    it("reads a file", () => {
      const r = virtualShell("cat README.md", FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("# Hello\n\nThis is a test project.\n");
    });

    it("returns error for missing file", () => {
      const r = virtualShell("cat missing.txt", FILES);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("No such file or directory");
    });

    it("reads multiple files", () => {
      const r = virtualShell("cat config/settings.yml config/routes.yml", FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("app:");
      expect(r.stdout).toContain("routes:");
    });
  });

  describe("grep", () => {
    it("searches a single file", () => {
      const r = virtualShell("grep export src/index.ts", FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("export const name");
    });

    it("searches recursively with .", () => {
      const r = virtualShell('grep -r "export" .', FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("src/index.ts:");
      expect(r.stdout).toContain("src/utils.ts:");
    });

    it("searches recursively in a subdirectory", () => {
      const r = virtualShell('grep -r "name" config/', FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("config/settings.yml:");
    });

    it("supports case-insensitive search", () => {
      const r = virtualShell('grep -ri "HELLO" .', FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("# Hello");
    });

    it("returns exit 1 for no matches", () => {
      const r = virtualShell('grep "nonexistent" README.md', FILES);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
    });

    it("greps piped input", () => {
      const r = virtualShell('cat src/index.ts | grep version', FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("version");
    });
  });

  describe("find", () => {
    it("finds all files", () => {
      const r = virtualShell("find . -type f", FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("./README.md");
      expect(r.stdout).toContain("./src/index.ts");
    });

    it("finds by name pattern", () => {
      const r = virtualShell('find . -name "*.ts"', FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("./src/index.ts");
      expect(r.stdout).toContain("./src/utils.ts");
      expect(r.stdout).not.toContain("README.md");
    });

    it("supports OR patterns", () => {
      const r = virtualShell('find . -name "*.ts" -o -name "*.yml"', FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("./src/index.ts");
      expect(r.stdout).toContain("./config/settings.yml");
    });

    it("returns error for -exec", () => {
      const r = virtualShell("find . -type f -exec wc -l {} +", FILES);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("find -exec is not supported");
    });

    it("finds directories", () => {
      const r = virtualShell("find . -type d", FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("./src");
      expect(r.stdout).toContain("./config");
    });
  });

  describe("ls", () => {
    it("lists root entries", () => {
      const r = virtualShell("ls", FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("README.md");
      expect(r.stdout).toContain("src");
      expect(r.stdout).toContain("config");
    });

    it("lists subdirectory", () => {
      const r = virtualShell("ls src", FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("index.ts");
      expect(r.stdout).toContain("utils.ts");
    });

    it("returns error for missing directory", () => {
      const r = virtualShell("ls nonexistent", FILES);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("No such file or directory");
    });
  });

  describe("head / tail", () => {
    it("head returns first N lines", () => {
      const r = virtualShell("head -n 1 README.md", FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("# Hello\n");
    });

    it("tail returns last N lines", () => {
      const r = virtualShell("tail -n 2 src/index.ts", FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("version");
    });
  });

  describe("wc", () => {
    it("counts lines", () => {
      const r = virtualShell("wc -l src/utils.ts", FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("3");
    });

    it("counts piped input", () => {
      const r = virtualShell("find . -type f | wc -l", FILES);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("5");
    });
  });

  describe("pipes", () => {
    it("pipes grep into head", () => {
      const r = virtualShell('grep -r "export" . | head -n 1', FILES);
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
    });

    it("pipes find into sort", () => {
      const r = virtualShell("find . -type f | sort", FILES);
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.trim().split("\n");
      expect(lines[0]).toBe("./README.md");
    });
  });

  describe("chaining", () => {
    it("&& runs second on success", () => {
      const r = virtualShell("echo hello && echo world", FILES);
      expect(r.stdout).toContain("world");
    });

    it("&& skips second on failure", () => {
      const r = virtualShell("cat missing.txt && echo world", FILES);
      expect(r.stdout).not.toContain("world");
    });

    it("|| runs second on failure", () => {
      const r = virtualShell("cat missing.txt || echo fallback", FILES);
      expect(r.stdout).toContain("fallback");
    });
  });

  describe("unsupported commands", () => {
    it("returns exit 127", () => {
      const r = virtualShell("rm -rf /", FILES);
      expect(r.exitCode).toBe(127);
      expect(r.stderr).toContain("not supported");
    });
  });

  describe("pathPrefixes option", () => {
    it("strips string prefixes from paths", () => {
      const r = virtualShell("cat /workspace/README.md", FILES, {
        pathPrefixes: ["/workspace/"],
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("# Hello");
    });

    it("strips regex prefixes from paths", () => {
      const r = virtualShell("cat /app/sandbox/abc123/src/index.ts", FILES, {
        pathPrefixes: [/^\/app\/sandbox\/[^/]+\//],
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("convex-shell");
    });
  });

  describe("2>/dev/null", () => {
    it("suppresses stderr", () => {
      const r = virtualShell("cat missing.txt 2>/dev/null", FILES);
      expect(r.stderr).toBe("");
    });
  });
});
