# convex-shell

A virtual shell that runs read-only commands against in-memory files. Zero dependencies, pure TypeScript.

Built for AI agents that need to explore files without disk access — works great with [Convex](https://convex.dev), Cloudflare Workers, or anywhere you have files as strings.

## Usage

```typescript
import { virtualShell } from "convex-shell";

const files = [
  { path: "src/index.ts", content: 'export const hello = "world";\n' },
  { path: "src/utils.ts", content: "export function add(a: number, b: number) {\n  return a + b;\n}\n" },
  { path: "config/app.yml", content: "name: my-app\ndebug: true\n" },
];

// Basic commands
virtualShell("cat src/index.ts", files);
// → { stdout: 'export const hello = "world";\n', stderr: "", exitCode: 0 }

virtualShell('grep -r "export" .', files);
// → { stdout: "src/index.ts:export const hello...\nsrc/utils.ts:export function...\n", ... }

virtualShell('find . -name "*.ts"', files);
// → { stdout: "./src/index.ts\n./src/utils.ts\n", ... }

// Pipes and chaining
virtualShell("find . -type f | wc -l", files);
// → { stdout: "       3\n", ... }

virtualShell('grep -r "export" . | head -n 1', files);
// → { stdout: "src/index.ts:export const hello...\n", ... }

virtualShell("cat missing.txt || echo fallback", files);
// → { stdout: "fallback\n", ... }
```

## Supported Commands

| Command | Flags |
|---------|-------|
| `cat`   | Multiple files |
| `grep`  | `-r`, `-i`, `-n`, `--include` |
| `find`  | `-name`, `-type f/d`, `-o` (OR) |
| `ls`    | `-l` |
| `head`  | `-n` |
| `tail`  | `-n` |
| `wc`    | `-l`, `-w`, `-c` |
| `echo`  | — |
| `pwd`   | — |
| `sort`  | `-r`, `-n` |
| `uniq`  | — |
| `cut`   | `-d`, `-f` |
| `tr`    | character replacement |

**Shell features:** pipes (`|`), chaining (`&&`, `||`), stderr redirect (`2>/dev/null`), quoted strings, escape characters.

## Options

```typescript
virtualShell(command, files, {
  // Working directory (default: ".")
  cwd: "src",

  // Strip absolute path prefixes so commands like
  // `cat /workspace/src/index.ts` resolve to `src/index.ts`
  pathPrefixes: [
    "/workspace/",
    /^\/app\/sandbox\/[^/]+\//,
  ],
});

// Shorthand: pass cwd as string
virtualShell("ls", files, "src");
```

## With Convex

```typescript
// convex/workspace.ts
import { query } from "./_generated/server";
import { v } from "convex/values";
import { virtualShell } from "convex-shell";

export const executeCommand = query({
  args: {
    command: v.string(),
    userId: v.id("users"),
    organizationId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("files")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
      .collect();

    const workspace = files.map((f) => ({ path: f.path, content: f.content }));
    const result = virtualShell(args.command, workspace);

    return {
      stdout: result.stdout.slice(0, 50_000),
      stderr: result.stderr.slice(0, 5_000),
      exitCode: result.exitCode,
    };
  },
});
```

## API

### `virtualShell(command, files, options?)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `command` | `string` | Shell command to execute |
| `files` | `VFile[]` | Array of `{ path: string, content: string }` |
| `options` | `ShellOptions \| string` | Options object or cwd string |

Returns `ShellResult`:

```typescript
{
  stdout: string;   // Command output
  stderr: string;   // Error output
  exitCode: number; // 0 = success, 1 = error, 127 = unknown command
}
```

## License

Apache-2.0
