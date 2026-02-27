/**
 * convex-shell — Virtual Shell
 *
 * A pure TypeScript virtual shell that executes read-only commands against
 * an in-memory file list. No disk, no child_process, zero dependencies.
 *
 * Supports: cat, grep, find, ls, head, tail, wc, echo, pwd,
 *           sort, uniq, cut, tr
 * Supports: pipes (|), chaining (&&, ||), stderr redirect (2>/dev/null)
 *
 * @example
 * ```ts
 * import { virtualShell } from "convex-shell";
 *
 * const files = [
 *   { path: "src/index.ts", content: "export const hello = 'world';\n" },
 *   { path: "README.md", content: "# My Project\n\nHello world.\n" },
 * ];
 *
 * const result = virtualShell("grep -r hello .", files);
 * // → { stdout: "src/index.ts:export const hello = 'world';\n", stderr: "", exitCode: 0 }
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VFile {
  path: string;
  content: string;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellOptions {
  /**
   * Current working directory for path resolution. Defaults to ".".
   */
  cwd?: string;
  /**
   * Absolute path prefixes to strip from file paths. This is useful when
   * commands reference absolute paths (e.g. `/workspace/project/src/index.ts`)
   * but your files use relative paths (e.g. `src/index.ts`).
   *
   * Each entry can be a string or a RegExp.
   *
   * @example
   * ```ts
   * virtualShell("cat /workspace/src/index.ts", files, {
   *   pathPrefixes: ["/workspace/"],
   * });
   * ```
   */
  pathPrefixes?: (string | RegExp)[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function virtualShell(
  command: string,
  files: VFile[],
  options: ShellOptions | string = "."
): ShellResult {
  const opts: ShellOptions =
    typeof options === "string" ? { cwd: options } : options;
  const cwd = opts.cwd ?? ".";
  const ctx: ShellContext = { files, cwd, pathPrefixes: opts.pathPrefixes ?? [] };

  try {
    return execChain(command.trim(), ctx);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: msg, exitCode: 1 };
  }
}

// ---------------------------------------------------------------------------
// Internal context passed through all commands
// ---------------------------------------------------------------------------

interface ShellContext {
  files: VFile[];
  cwd: string;
  pathPrefixes: (string | RegExp)[];
}

// ---------------------------------------------------------------------------
// Chain execution: && and ||
// ---------------------------------------------------------------------------

function execChain(command: string, ctx: ShellContext): ShellResult {
  const segments = parseChain(command);
  let result: ShellResult = { stdout: "", stderr: "", exitCode: 0 };

  for (const seg of segments) {
    if (seg.operator === "&&" && result.exitCode !== 0) continue;
    if (seg.operator === "||" && result.exitCode === 0) continue;
    result = execPipeline(seg.cmd.trim(), ctx);
  }

  return result;
}

interface ChainSegment {
  operator: "" | "&&" | "||";
  cmd: string;
}

function parseChain(command: string): ChainSegment[] {
  const result: ChainSegment[] = [];
  let buf = "";
  let i = 0;
  let inSQ = false;
  let inDQ = false;
  let pendingOp: "" | "&&" | "||" = "";

  while (i < command.length) {
    const ch = command[i];
    if (ch === "'" && !inDQ) { inSQ = !inSQ; buf += ch; i++; continue; }
    if (ch === '"' && !inSQ) { inDQ = !inDQ; buf += ch; i++; continue; }

    if (!inSQ && !inDQ) {
      if (command[i] === "&" && command[i + 1] === "&") {
        if (buf.trim()) result.push({ operator: pendingOp, cmd: buf.trim() });
        buf = "";
        pendingOp = "&&";
        i += 2;
        continue;
      }
      if (command[i] === "|" && command[i + 1] === "|") {
        if (buf.trim()) result.push({ operator: pendingOp, cmd: buf.trim() });
        buf = "";
        pendingOp = "||";
        i += 2;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) result.push({ operator: pendingOp, cmd: buf.trim() });
  return result;
}

// ---------------------------------------------------------------------------
// Pipeline execution: cmd1 | cmd2 | cmd3
// ---------------------------------------------------------------------------

function execPipeline(command: string, ctx: ShellContext): ShellResult {
  const parts = splitPipes(command);
  let result: ShellResult = { stdout: "", stderr: "", exitCode: 0 };

  for (let i = 0; i < parts.length; i++) {
    const input = i === 0 ? "" : result.stdout;
    result = execSingle(parts[i].trim(), ctx, input);
  }

  return result;
}

function splitPipes(command: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let i = 0;
  let inSQ = false;
  let inDQ = false;

  while (i < command.length) {
    const ch = command[i];
    if (ch === "'" && !inDQ) { inSQ = !inSQ; buf += ch; i++; continue; }
    if (ch === '"' && !inSQ) { inDQ = !inDQ; buf += ch; i++; continue; }

    if (!inSQ && !inDQ && ch === "|" && command[i + 1] !== "|") {
      parts.push(buf);
      buf = "";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf) parts.push(buf);
  return parts;
}

// ---------------------------------------------------------------------------
// Single command execution
// ---------------------------------------------------------------------------

function execSingle(command: string, ctx: ShellContext, pipeInput: string): ShellResult {
  const cmd = command.replace(/\s*2>\s*\/dev\/null/g, "").trim();
  const suppressErrors = command.includes("2>/dev/null");

  const tokens = tokenize(cmd);
  if (tokens.length === 0) return { stdout: "", stderr: "", exitCode: 0 };

  const baseCmd = tokens[0];
  let result: ShellResult;

  switch (baseCmd) {
    case "cat":
      result = cmdCat(tokens.slice(1), ctx, pipeInput);
      break;
    case "grep":
      result = cmdGrep(tokens.slice(1), ctx, pipeInput);
      break;
    case "find":
      result = cmdFind(tokens.slice(1), ctx);
      break;
    case "ls":
      result = cmdLs(tokens.slice(1), ctx);
      break;
    case "head":
      result = cmdHead(tokens.slice(1), ctx, pipeInput);
      break;
    case "tail":
      result = cmdTail(tokens.slice(1), ctx, pipeInput);
      break;
    case "wc":
      result = cmdWc(tokens.slice(1), ctx, pipeInput);
      break;
    case "echo":
      result = cmdEcho(tokens.slice(1));
      break;
    case "pwd":
      result = { stdout: ctx.cwd + "\n", stderr: "", exitCode: 0 };
      break;
    case "sort":
      result = cmdSort(tokens.slice(1), pipeInput);
      break;
    case "uniq":
      result = cmdUniq(pipeInput);
      break;
    case "cut":
      result = cmdCut(tokens.slice(1), pipeInput);
      break;
    case "tr":
      result = cmdTr(tokens.slice(1), pipeInput);
      break;
    default:
      result = {
        stdout: "",
        stderr: `${baseCmd}: command not supported in virtual shell`,
        exitCode: 127,
      };
  }

  if (suppressErrors) result.stderr = "";
  return result;
}

// ---------------------------------------------------------------------------
// Tokenizer (handles quotes and escapes)
// ---------------------------------------------------------------------------

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSQ = false;
  let inDQ = false;
  let escape = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === "\\" && !inSQ) {
      escape = true;
      continue;
    }

    if (ch === "'" && !inDQ) {
      inSQ = !inSQ;
      continue;
    }

    if (ch === '"' && !inSQ) {
      inDQ = !inDQ;
      continue;
    }

    if (ch === " " && !inSQ && !inDQ) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolvePath(p: string, ctx: ShellContext): string {
  let resolved = p;

  // Strip user-configured absolute path prefixes
  for (const prefix of ctx.pathPrefixes) {
    if (typeof prefix === "string") {
      if (resolved.startsWith(prefix)) {
        resolved = resolved.slice(prefix.length);
        break;
      }
    } else {
      if (prefix.test(resolved)) {
        resolved = resolved.replace(prefix, "");
        break;
      }
    }
  }

  // Handle ./
  if (resolved.startsWith("./")) resolved = resolved.slice(2);

  // Handle cwd prefix
  if (ctx.cwd !== "." && ctx.cwd !== "/" && resolved.startsWith(ctx.cwd + "/")) {
    resolved = resolved.slice(ctx.cwd.length + 1);
  }

  return resolved;
}

function findFile(filePath: string, ctx: ShellContext): VFile | undefined {
  const resolved = resolvePath(filePath, ctx);
  return ctx.files.find((f) => f.path === resolved || f.path === "./" + resolved);
}

function matchGlob(pattern: string, filePath: string): boolean {
  const regexStr = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp("^" + regexStr + "$").test(filePath);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdCat(args: string[], ctx: ShellContext, pipeInput: string): ShellResult {
  if (args.some((a) => a === ">" || a === ">>")) {
    return {
      stdout: "",
      stderr: "cat: write operations not supported in virtual shell",
      exitCode: 1,
    };
  }

  if (args.length === 0 && pipeInput) {
    return { stdout: pipeInput, stderr: "", exitCode: 0 };
  }

  const outputs: string[] = [];
  const errors: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    const file = findFile(arg, ctx);
    if (file) {
      outputs.push(file.content);
    } else {
      errors.push(`cat: ${arg}: No such file or directory`);
    }
  }

  return {
    stdout: outputs.join(""),
    stderr: errors.join("\n"),
    exitCode: errors.length > 0 && outputs.length === 0 ? 1 : 0,
  };
}

function cmdGrep(args: string[], ctx: ShellContext, pipeInput: string): ShellResult {
  let recursive = false;
  let ignoreCase = false;
  let lineNumbers = false;
  let includePattern = "";
  let pattern = "";
  const paths: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-r" || arg === "-R" || arg === "--recursive") {
      recursive = true;
    } else if (arg === "-i" || arg === "--ignore-case") {
      ignoreCase = true;
    } else if (arg === "-n" || arg === "--line-number") {
      lineNumbers = true;
    } else if (arg === "-ri" || arg === "-ir" || arg === "-rn" || arg === "-nr" ||
               arg === "-rin" || arg === "-rni" || arg === "-nri" || arg === "-nir") {
      recursive = arg.includes("r") || arg.includes("R");
      ignoreCase = arg.includes("i");
      lineNumbers = arg.includes("n");
    } else if (arg === "--include" || arg.startsWith("--include=")) {
      if (arg.includes("=")) {
        includePattern = arg.split("=")[1].replace(/^["']|["']$/g, "");
      } else {
        i++;
        includePattern = (args[i] || "").replace(/^["']|["']$/g, "");
      }
    } else if (!pattern) {
      pattern = arg.replace(/^["']|["']$/g, "");
    } else {
      paths.push(arg);
    }
    i++;
  }

  if (!pattern) {
    return { stdout: "", stderr: "grep: no pattern specified", exitCode: 2 };
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(escaped, ignoreCase ? "i" : "");
  }

  // Grep piped input
  if (pipeInput && paths.length === 0) {
    const lines = pipeInput.split("\n");
    const matches = lines.filter((l) => regex.test(l));
    return {
      stdout: matches.join("\n") + (matches.length ? "\n" : ""),
      stderr: "",
      exitCode: matches.length > 0 ? 0 : 1,
    };
  }

  // Determine which files to search
  let searchFiles = ctx.files;

  if (paths.length > 0) {
    if (recursive) {
      const isSearchAll = paths.every((p) => {
        const rp = resolvePath(p, ctx);
        return rp === "." || rp === "/" || rp === "";
      });

      if (!isSearchAll) {
        searchFiles = ctx.files.filter((f) => {
          const resolved = resolvePath(f.path, ctx);
          return paths.some((p) => {
            const rp = resolvePath(p, ctx);
            return resolved.startsWith(rp.replace(/\/$/, "") + "/") || resolved === rp;
          });
        });
      }
    } else {
      searchFiles = [];
      for (const p of paths) {
        const rp = resolvePath(p, ctx);
        if (rp.includes("*")) {
          searchFiles.push(...ctx.files.filter((f) => matchGlob(rp, f.path)));
        } else {
          const f = findFile(p, ctx);
          if (f) searchFiles.push(f);
        }
      }
    }
  }

  // Apply --include filter
  if (includePattern) {
    const incGlob = includePattern.replace(/^["']|["']$/g, "");
    searchFiles = searchFiles.filter((f) => {
      const basename = f.path.split("/").pop() || "";
      return matchGlob(incGlob, basename);
    });
  }

  const multiFile = searchFiles.length > 1;
  const output: string[] = [];

  for (const file of searchFiles) {
    const lines = file.content.split("\n");
    for (let ln = 0; ln < lines.length; ln++) {
      if (regex.test(lines[ln])) {
        let prefix = "";
        if (multiFile) prefix = file.path + ":";
        if (lineNumbers) prefix += (ln + 1) + ":";
        output.push(prefix + lines[ln]);
      }
    }
  }

  return {
    stdout: output.join("\n") + (output.length ? "\n" : ""),
    stderr: "",
    exitCode: output.length > 0 ? 0 : 1,
  };
}

function cmdFind(args: string[], ctx: ShellContext): ShellResult {
  let searchPath = ".";
  const namePatterns: string[] = [];
  let typeFilter = "";
  let hasExec = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-name") {
      i++;
      namePatterns.push((args[i] || "").replace(/^["']|["']$/g, ""));
    } else if (arg === "-type") {
      i++;
      typeFilter = args[i] || "";
    } else if (arg === "-o" || arg === "-or") {
      // OR operator — handled by collecting multiple -name patterns
    } else if (arg === "-exec") {
      hasExec = true;
      i++;
      while (i < args.length && args[i] !== ";" && args[i] !== "\\;" && args[i] !== "+") {
        i++;
      }
    } else if (arg === "(" || arg === ")" || arg === "-and") {
      // Grouping/AND — ignored, multiple -name treated as OR
    } else if (!arg.startsWith("-")) {
      if (i === 0 || namePatterns.length === 0) searchPath = arg;
    }
    i++;
  }

  const resolvedSearch = resolvePath(searchPath, ctx);

  let matchedFiles = ctx.files.filter((f) => {
    if (resolvedSearch !== "." && resolvedSearch !== "/") {
      const rp = resolvePath(f.path, ctx);
      return rp.startsWith(resolvedSearch.replace(/\/$/, "") + "/") || rp === resolvedSearch;
    }
    return true;
  });

  if (namePatterns.length > 0) {
    matchedFiles = matchedFiles.filter((f) => {
      const basename = f.path.split("/").pop() || "";
      return namePatterns.some((pat) => matchGlob(pat, basename));
    });
  }

  // Type filter: -type d returns unique directory paths
  if (typeFilter === "d") {
    const dirs = new Set<string>();
    for (const f of matchedFiles) {
      const parts = f.path.split("/");
      for (let j = 1; j < parts.length; j++) {
        dirs.add(parts.slice(0, j).join("/"));
      }
    }
    const sorted = [...dirs].sort();
    return {
      stdout: sorted.map((d) => "./" + d).join("\n") + (sorted.length ? "\n" : ""),
      stderr: "",
      exitCode: 0,
    };
  }

  const sorted = matchedFiles.map((f) => "./" + f.path).sort();

  if (hasExec) {
    return {
      stdout: "",
      stderr: "find -exec is not supported in virtual shell. Use the matched files with individual commands instead (e.g. 'wc -l file1 file2' or pipe: 'find ... | ...').",
      exitCode: 1,
    };
  }

  return {
    stdout: sorted.join("\n") + (sorted.length ? "\n" : ""),
    stderr: "",
    exitCode: 0,
  };
}

function cmdLs(args: string[], ctx: ShellContext): ShellResult {
  let longFormat = false;
  let targetPath = ".";

  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (arg.includes("l")) longFormat = true;
    } else {
      targetPath = arg;
    }
  }

  const resolvedTarget = resolvePath(targetPath, ctx);

  const entries = new Map<string, { isDir: boolean; size: number }>();

  for (const f of ctx.files) {
    const rp = resolvePath(f.path, ctx);
    let relative: string;

    if (resolvedTarget === "." || resolvedTarget === "/" || resolvedTarget === "") {
      relative = rp;
    } else if (rp.startsWith(resolvedTarget.replace(/\/$/, "") + "/")) {
      relative = rp.slice(resolvedTarget.replace(/\/$/, "").length + 1);
    } else {
      continue;
    }

    const parts = relative.split("/");
    if (parts.length === 1) {
      entries.set(parts[0], { isDir: false, size: f.content.length });
    } else {
      entries.set(parts[0], { isDir: true, size: 0 });
    }
  }

  if (entries.size === 0) {
    return {
      stdout: "",
      stderr: `ls: cannot access '${targetPath}': No such file or directory`,
      exitCode: 2,
    };
  }

  const sorted = [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  if (longFormat) {
    const lines = sorted.map(([name, info]) => {
      const type = info.isDir ? "d" : "-";
      const perms = info.isDir ? "rwxr-xr-x" : "rw-r--r--";
      const size = String(info.size).padStart(8);
      return `${type}${perms}  1 user user ${size} Jan  1 00:00 ${name}`;
    });
    return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
  }

  return {
    stdout: sorted.map(([name]) => name).join("\n") + "\n",
    stderr: "",
    exitCode: 0,
  };
}

function cmdHead(args: string[], ctx: ShellContext, pipeInput: string): ShellResult {
  let lines = 10;
  const filePaths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-n" || args[i] === "-") {
      i++;
      lines = parseInt(args[i]) || 10;
    } else if (args[i].match(/^-\d+$/)) {
      lines = parseInt(args[i].slice(1));
    } else if (!args[i].startsWith("-")) {
      filePaths.push(args[i]);
    }
  }

  if (pipeInput && filePaths.length === 0) {
    const result = pipeInput.split("\n").slice(0, lines).join("\n");
    return { stdout: result + (result ? "\n" : ""), stderr: "", exitCode: 0 };
  }

  const outputs: string[] = [];
  const errors: string[] = [];

  for (const fp of filePaths) {
    const file = findFile(fp, ctx);
    if (file) {
      const result = file.content.split("\n").slice(0, lines).join("\n");
      outputs.push(result);
    } else {
      errors.push(`head: cannot open '${fp}' for reading: No such file or directory`);
    }
  }

  return {
    stdout: outputs.join("\n") + (outputs.length ? "\n" : ""),
    stderr: errors.join("\n"),
    exitCode: errors.length > 0 && outputs.length === 0 ? 1 : 0,
  };
}

function cmdTail(args: string[], ctx: ShellContext, pipeInput: string): ShellResult {
  let lines = 10;
  const filePaths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-n") {
      i++;
      lines = parseInt(args[i]) || 10;
    } else if (args[i].match(/^-\d+$/)) {
      lines = parseInt(args[i].slice(1));
    } else if (!args[i].startsWith("-")) {
      filePaths.push(args[i]);
    }
  }

  if (pipeInput && filePaths.length === 0) {
    const allLines = pipeInput.split("\n");
    const result = allLines.slice(-lines).join("\n");
    return { stdout: result + (result ? "\n" : ""), stderr: "", exitCode: 0 };
  }

  const outputs: string[] = [];
  const errors: string[] = [];

  for (const fp of filePaths) {
    const file = findFile(fp, ctx);
    if (file) {
      const allLines = file.content.split("\n");
      outputs.push(allLines.slice(-lines).join("\n"));
    } else {
      errors.push(`tail: cannot open '${fp}' for reading: No such file or directory`);
    }
  }

  return {
    stdout: outputs.join("\n") + (outputs.length ? "\n" : ""),
    stderr: errors.join("\n"),
    exitCode: errors.length > 0 && outputs.length === 0 ? 1 : 0,
  };
}

function cmdWc(args: string[], ctx: ShellContext, pipeInput: string): ShellResult {
  let countLines = false;
  let countWords = false;
  let countBytes = false;
  const filePaths: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (arg.includes("l")) countLines = true;
      if (arg.includes("w")) countWords = true;
      if (arg.includes("c")) countBytes = true;
    } else {
      filePaths.push(arg);
    }
  }

  if (!countLines && !countWords && !countBytes) {
    countLines = true;
    countWords = true;
    countBytes = true;
  }

  const formatWc = (content: string, name?: string) => {
    const parts: string[] = [];
    if (countLines) parts.push(String(content.split("\n").length - 1).padStart(8));
    if (countWords) parts.push(String(content.split(/\s+/).filter(Boolean).length).padStart(8));
    if (countBytes) parts.push(String(content.length).padStart(8));
    if (name) parts.push(" " + name);
    return parts.join("");
  };

  if (pipeInput && filePaths.length === 0) {
    return { stdout: formatWc(pipeInput) + "\n", stderr: "", exitCode: 0 };
  }

  const outputs: string[] = [];
  const errors: string[] = [];

  for (const fp of filePaths) {
    const file = findFile(fp, ctx);
    if (file) {
      outputs.push(formatWc(file.content, fp));
    } else {
      errors.push(`wc: ${fp}: No such file or directory`);
    }
  }

  return {
    stdout: outputs.join("\n") + (outputs.length ? "\n" : ""),
    stderr: errors.join("\n"),
    exitCode: errors.length > 0 && outputs.length === 0 ? 1 : 0,
  };
}

function cmdEcho(args: string[]): ShellResult {
  return { stdout: args.join(" ") + "\n", stderr: "", exitCode: 0 };
}

function cmdSort(args: string[], pipeInput: string): ShellResult {
  const lines = pipeInput.split("\n").filter(Boolean);
  const numeric = args.includes("-n");
  const reverse = args.includes("-r") || args.includes("-rn") || args.includes("-nr");

  if (numeric) {
    lines.sort((a, b) => {
      const na = parseFloat(a) || 0;
      const nb = parseFloat(b) || 0;
      return na - nb;
    });
  } else {
    lines.sort();
  }

  if (reverse) lines.reverse();
  return {
    stdout: lines.join("\n") + (lines.length ? "\n" : ""),
    stderr: "",
    exitCode: 0,
  };
}

function cmdUniq(pipeInput: string): ShellResult {
  const lines = pipeInput.split("\n");
  const result = lines.filter((line, i) => i === 0 || line !== lines[i - 1]);
  return { stdout: result.join("\n"), stderr: "", exitCode: 0 };
}

function cmdCut(args: string[], pipeInput: string): ShellResult {
  let delimiter = "\t";
  let fields: number[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-d") {
      i++;
      delimiter = args[i] || "\t";
    } else if (args[i].startsWith("-d")) {
      delimiter = args[i].slice(2);
    } else if (args[i] === "-f") {
      i++;
      fields = (args[i] || "").split(",").map((f) => parseInt(f) - 1);
    } else if (args[i].startsWith("-f")) {
      fields = args[i].slice(2).split(",").map((f) => parseInt(f) - 1);
    }
  }

  const lines = pipeInput.split("\n");
  const result = lines.map((line) => {
    if (!line) return line;
    const parts = line.split(delimiter);
    return fields.map((f) => parts[f] || "").join(delimiter);
  });

  return { stdout: result.join("\n"), stderr: "", exitCode: 0 };
}

function cmdTr(args: string[], pipeInput: string): ShellResult {
  if (args.length < 2) {
    return { stdout: pipeInput, stderr: "tr: missing operand", exitCode: 1 };
  }

  const set1 = args[0];
  const set2 = args[1];

  let result = pipeInput;
  for (let i = 0; i < set1.length && i < set2.length; i++) {
    result = result.split(set1[i]).join(set2[i]);
  }

  return { stdout: result, stderr: "", exitCode: 0 };
}
