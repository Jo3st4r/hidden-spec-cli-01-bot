// mend: applies an AI-written edit to a tree of text files, as SPEC.md specifies.
//
// Four patch formats: unified diffs (often with wrong line numbers), SEARCH/REPLACE
// blocks, V4A patches, and JSON tool calls. An edit names old lines O replaced by
// new lines N; O is found at the first of three matching tiers (exact, trailing
// whitespace ignored, leading and trailing whitespace ignored). Every edit of a
// patch is tried in order against the tree the earlier edits left; a failed edit
// changes nothing and the edits after it still run; when any edit failed, no file
// is written. Node 22, the standard library alone; run as `node main.ts [options]
// [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch that cannot be read in its format: exit 2, `error: parse <line>`. */
class ParseError extends Error {
  readonly line: number;
  constructor(line: number) {
    super(`error: parse ${line}`);
    this.line = line;
  }
}

/** One edit that failed: exit 1, `error: <code> <path>`. */
class EditFailure extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed, no empty piece after a final `\n`. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: a path is safe when it is not empty, does not start with `/`, holds no `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break (CRLF when its first line feed follows a carriage return), its lines, and whether it ends with a line break. An empty file has no lines and no final break. */
interface FileLines {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const lines = text.split(br);
  if (finalBreak) lines.pop();
  return { br, lines, finalBreak };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, as (old, new) pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

const stripTrailingWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const isOnlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

function linesEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

/** Start positions where `oldLines` occurs in `fileLines` at `tier`, at or after `from`. When `endAt` is given, only occurrences ending exactly there. */
function occurrences(oldLines: string[], fileLines: string[], tier: number, from: number, endAt?: number): number[] {
  const out: number[] = [];
  const n = oldLines.length;
  if (n === 0) return out;
  for (let i = from; i + n <= fileLines.length; i++) {
    if (endAt !== undefined && i + n !== endAt) continue;
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!linesEqual(oldLines[j]!, fileLines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with `--strict`) at which `oldLines` occurs at least once, with its positions. */
function findTier(oldLines: string[], fileLines: string[], from: number, strict: boolean, endAt?: number): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const positions = occurrences(oldLines, fileLines, tier, from, endAt);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a hunk or chunk body: `ctx` (context, in both O and N), `old` (only O), `new` (only N). */
interface BodyEntry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

const oldSide = (body: BodyEntry[]): BodyEntry[] => body.filter((b) => b.kind !== 'new');
const newSide = (body: BodyEntry[]): BodyEntry[] => body.filter((b) => b.kind !== 'old');

/**
 * The lines N writes when it replaces O at `pos`: a context line is the file's own
 * matched line, never the patch's; at tier 2 every other line is re-indented (the
 * leading spaces and tabs P of O's first line replaced by F, those of the file's
 * first matched line); at tiers 0 and 1 the other lines are written as they are.
 */
function buildNewLines(body: BodyEntry[], fileLines: string[], pos: number, tier: number): string[] {
  const olds = oldSide(body);
  const news = newSide(body);
  const ctxOldIndex: number[] = [];
  olds.forEach((b, i) => {
    if (b.kind === 'ctx') ctxOldIndex.push(i);
  });
  const pfx = olds.length > 0 ? leadingWs(olds[0]!.text) : '';
  const ffx = pos < fileLines.length ? leadingWs(fileLines[pos]!) : '';
  const out: string[] = [];
  let m = 0;
  for (const e of news) {
    if (e.kind === 'ctx') {
      out.push(fileLines[pos + ctxOldIndex[m]!]!);
      m += 1;
    } else if (tier === 2 && !isOnlyWs(e.text) && e.text.startsWith(pfx)) {
      out.push(ffx + e.text.slice(pfx.length));
    } else {
      out.push(e.text);
    }
  }
  return out;
}

/** The same re-indentation for a SEARCH/REPLACE block, whose new lines are all "other" lines. */
function buildSrLines(oldLines: string[], newLines: string[], fileLines: string[], pos: number, tier: number): string[] {
  const pfx = oldLines.length > 0 ? leadingWs(oldLines[0]!) : '';
  const ffx = pos < fileLines.length ? leadingWs(fileLines[pos]!) : '';
  return newLines.map((t) => {
    if (tier === 2 && !isOnlyWs(t) && t.startsWith(pfx)) return ffx + t.slice(pfx.length);
    return t;
  });
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

function requireSafe(p: string): void {
  if (!isSafePath(p)) throw new EditFailure('unsafe', p);
}

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    requireSafe(p);
    const t = tree.get(p);
    if (t === null) throw new EditFailure('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      requireSafe(p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const file = splitFile(before);
      if (line < 0 || line > file.lines.length) throw new EditFailure('no-match', p);
      file.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(file));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseError(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseError(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseError(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseError(i + 1);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** A: the old-file start line from the header (1-based). */
  a: number;
  body: BodyEntry[];
  /**
   * Parallel to `body`: whether a `\` line immediately follows that body entry.
   * The hunk's no-newline flag is the value on its last context or `+` entry.
   */
  markAfter: boolean[];
}

interface UnifiedSection {
  oldPath: string | null; // null: /dev/null, no file
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, surrounding spaces removed, one leading `a/` or `b/` removed. `/dev/null` means no file. */
function diffPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  const n = lines.length;

  /** Parse one hunk body starting after its header at index `h`; returns the hunk and the index after the body. */
  const parseHunkBody = (h: number): { hunk: Hunk; next: number } => {
    // Raw entries, marks included, so the `\` line can be tied to the line before it.
    const raw: Array<BodyEntry | 'mark'> = [];
    let j = h;
    while (j < n) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
        if (l.startsWith('\\')) raw.push('mark');
        else if (l === '') raw.push({ kind: 'ctx', text: '' });
        else if (l.startsWith(' ')) raw.push({ kind: 'ctx', text: l.slice(1) });
        else if (l.startsWith('-')) raw.push({ kind: 'old', text: l.slice(1) });
        else raw.push({ kind: 'new', text: l.slice(1) });
        j += 1;
      } else break;
    }
    // Empty lines at the end of a body are not part of it: drop trailing context
    // lines with empty text, and any mark tied to one of them. A mark after a
    // non-empty line stays: it is the `\ No newline at end of file` flag.
    let end = raw.length;
    while (end > 0) {
      const last = raw[end - 1]!;
      if (last !== 'mark' && last.kind === 'ctx' && last.text === '') {
        end -= 1;
      } else if (last === 'mark' && end >= 2) {
        const prev = raw[end - 2]!;
        if (prev !== 'mark' && prev.kind === 'ctx' && prev.text === '') end -= 1;
        else break;
      } else break;
    }
    const kept = raw.slice(0, end);
    const body = kept.filter((e): e is BodyEntry => e !== 'mark');
    // For each body entry, whether a `\` line immediately followed it.
    const markAfter: boolean[] = [];
    {
      let bi = 0;
      for (let k = 0; k < kept.length; k++) {
        if (kept[k] === 'mark') continue;
        markAfter[bi] = kept[k + 1] === 'mark';
        bi += 1;
      }
    }
    return { hunk: { a: 0, body, markAfter }, next: j };
  };

  while (i < n) {
    const line = lines[i]!;
    let section: UnifiedSection | null = null;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new ParseError(i + 1);
      section = { oldPath: m[1]!, newPath: m[2]!, create: false, remove: false, hunks: [] };
      i += 1;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      section = { oldPath: diffPath(line), newPath: diffPath(lines[i + 1]!), create: false, remove: false, hunks: [] };
      i += 2;
    } else {
      // Prose outside a section is ignored; a hunk before any section is a parse error.
      if (line.startsWith('@@')) throw new ParseError(i + 1);
      i += 1;
      continue;
    }

    // The section's header: lines before its first hunk.
    let pairSeen = section.oldPath !== null || section.newPath !== null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    while (i < n) {
      const h = lines[i]!;
      if (h.startsWith('@@')) {
        const m = HUNK_HEAD.exec(h);
        if (m === null) throw new ParseError(i + 1);
        const parsed = parseHunkBody(i + 1);
        parsed.hunk.a = Number(m[1]);
        section.hunks.push(parsed.hunk);
        i = parsed.next;
        // Another hunk of this section follows at once, or the section ends.
        while (i < n && lines[i]!.startsWith('@@')) {
          const m2 = HUNK_HEAD.exec(lines[i]!);
          if (m2 === null) throw new ParseError(i + 1);
          const p2 = parseHunkBody(i + 1);
          p2.hunk.a = Number(m2[1]);
          section.hunks.push(p2.hunk);
          i = p2.next;
        }
        break;
      }
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        section.oldPath = diffPath(h);
        section.newPath = diffPath(lines[i + 1]!);
        pairSeen = true;
        i += 2;
        continue;
      }
      if (h.startsWith('--- ')) throw new ParseError(i + 2);
      if (h.startsWith('rename from ')) renameFrom = h.slice('rename from '.length).trim();
      else if (h.startsWith('rename to ')) renameTo = h.slice('rename to '.length).trim();
      else if (h.startsWith('new file mode')) section.create = true;
      else if (h.startsWith('deleted file mode')) section.remove = true;
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:` and any other line are ignored.
      i += 1;
    }
    if (!pairSeen) {
      if (renameFrom !== null) section.oldPath = renameFrom;
      if (renameTo !== null) section.newPath = renameTo;
    }
    sections.push(section);
  }

  if (sections.length === 0) throw new ParseError(1);
  return sections.map((s) => unifiedEdit(s));
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(hunk: Hunk): boolean {
  for (let i = hunk.body.length - 1; i >= 0; i--) {
    if (hunk.body[i]!.kind !== 'old') return hunk.markAfter[i] ?? false;
  }
  return false;
}

/** Apply a section's hunks to a file's text, in order, each to the result of the ones before it. */
function applyHunks(text: string, hunks: Hunk[], path: string, strict: boolean): string {
  const file = splitFile(text);
  let d = 0;
  for (const hunk of hunks) {
    const olds = oldSide(hunk.body);
    const news = newSide(hunk.body);
    const o = olds.map((b) => b.text);
    if (o.length > 0) {
      const found = findTier(o, file.lines, 0, strict);
      if (found === null) throw new EditFailure('no-match', path);
      const target = hunk.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const repl = buildNewLines(hunk.body, file.lines, best, found.tier);
      const touchesEnd = best + o.length === file.lines.length;
      file.lines.splice(best, o.length, ...repl);
      if (touchesEnd) file.finalBreak = !hunkNoEol(hunk);
      d += news.length - olds.length;
    } else {
      const at = Math.min(Math.max(hunk.a + d, 0), file.lines.length);
      file.lines.splice(at, 0, ...news.map((b) => b.text));
      if (at === file.lines.length) file.finalBreak = !hunkNoEol(hunk);
      d += news.length;
    }
  }
  return joinFile(file);
}

function unifiedEdit(s: UnifiedSection): Edit {
  const isCreate = s.oldPath === null || s.create;
  const isDelete = !isCreate && (s.newPath === null || s.remove);
  const isMove = !isCreate && !isDelete && s.oldPath !== s.newPath;
  if (isCreate) {
    const p = s.newPath ?? '';
    return (tree) => {
      requireSafe(p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      const added: string[] = [];
      for (const hunk of s.hunks) {
        for (const b of hunk.body) if (b.kind === 'new') added.push(b.text);
      }
      // A created file ends with a line break unless a `\` line follows its
      // last `+` line: find that line (the last `new` entry of the section)
      // and read whether a mark follows it in its own hunk.
      let noEol = false;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const hunk = s.hunks[hi]!;
        for (let bi = hunk.body.length - 1; bi >= 0; bi--) {
          if (hunk.body[bi]!.kind === 'new') {
            noEol = hunk.markAfter[bi] ?? false;
            break outer;
          }
        }
      }
      tree.now.set(p, added.length === 0 ? '' : added.join('\n') + (noEol ? '' : '\n'));
    };
  }
  if (isDelete) {
    const p = s.oldPath ?? '';
    return (tree) => {
      requireSafe(p);
      if (tree.get(p) === null) throw new EditFailure('missing', p);
      tree.now.set(p, null);
    };
  }
  if (isMove) {
    const oldP = s.oldPath!;
    const newP = s.newPath!;
    return (tree) => {
      requireSafe(oldP);
      requireSafe(newP);
      const before = tree.get(oldP);
      if (before === null) throw new EditFailure('missing', oldP);
      if (tree.get(newP) !== null) throw new EditFailure('exists', newP);
      const out = applyHunks(before, s.hunks, oldP, currentStrict());
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
    };
  }
  const p = s.oldPath!;
  return (tree) => {
    requireSafe(p);
    const before = tree.get(p);
    if (before === null) throw new EditFailure('missing', p);
    tree.now.set(p, applyHunks(before, s.hunks, p, currentStrict()));
  };
}

// `--strict` is read once per run; edits made by the parsers need it when they apply.
let strictFlag = false;
function currentStrict(): boolean {
  return strictFlag;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    // The path: the nearest line before the SEARCH line, after the previous
    // block's REPLACE line (or the start), that is not blank and does not start
    // with three backticks (surrounding whitespace removed).
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseError(searchLine + 1);
    // `=======` then `>>>>>>> REPLACE` after the SEARCH line.
    let sep = -1;
    for (let j = searchLine + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let rep = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (sep < 0 || rep < 0) throw new ParseError(searchLine + 1);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines));
    prevReplace = rep;
    prevPath = path;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree) => {
    requireSafe(path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFailure('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFailure('missing', path);
    const file = splitFile(before);
    const found = findTier(oldLines, file.lines, 0, currentStrict());
    if (found === null) throw new EditFailure('no-match', path);
    if (found.positions.length > 1) throw new EditFailure('ambiguous', path);
    const pos = found.positions[0]!;
    const repl = buildSrLines(oldLines, newLines, file.lines, pos, found.tier);
    file.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(file));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  /** The anchor text after `@@`, or '' for no anchor. */
  anchor: string;
  /** `*** End of File` closed this chunk: it is anchored to the end of the file. */
  eof: boolean;
  body: BodyEntry[];
}

type V4aSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[] };

const ADD_PREFIX = '*** Add File: ';
const DELETE_PREFIX = '*** Delete File: ';
const UPDATE_PREFIX = '*** Update File: ';
const MOVE_PREFIX = '*** Move to: ';

function parseV4a(lines: string[]): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = n - 1;
  while (last >= 0 && isBlank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new ParseError(n + 1);

  const sections: V4aSection[] = [];
  let i = first + 1;
  const end = last; // index of `*** End Patch`
  while (i < end) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith(ADD_PREFIX)) {
      const path = line.slice(ADD_PREFIX.length).trim();
      const fileLines: string[] = [];
      const blankFlags: boolean[] = [];
      i += 1;
      while (i < end) {
        const l = lines[i]!;
        if (l.startsWith(ADD_PREFIX) || l.startsWith(DELETE_PREFIX) || l.startsWith(UPDATE_PREFIX)) break;
        if (l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
          blankFlags.push(false);
          i += 1;
        } else if (l === '') {
          fileLines.push('');
          blankFlags.push(true);
          i += 1;
        } else {
          throw new ParseError(i + 1);
        }
      }
      // Blank lines at the end of a section are not part of it.
      while (fileLines.length > 0 && blankFlags[blankFlags.length - 1]) {
        fileLines.pop();
        blankFlags.pop();
      }
      sections.push({ kind: 'add', path, lines: fileLines });
      continue;
    }
    if (line.startsWith(DELETE_PREFIX)) {
      const path = line.slice(DELETE_PREFIX.length).trim();
      sections.push({ kind: 'delete', path });
      i += 1;
      continue;
    }
    if (line.startsWith(UPDATE_PREFIX)) {
      const path = line.slice(UPDATE_PREFIX.length).trim();
      const headerLine = i;
      i += 1;
      // `*** Move to: <path>` may be the section's first line (blank lines before it are ignored).
      let j = i;
      while (j < end && isBlank(lines[j]!)) j += 1;
      let moveTo: string | null = null;
      if (j < end && lines[j]!.startsWith(MOVE_PREFIX)) {
        moveTo = lines[j]!.slice(MOVE_PREFIX.length).trim();
        i = j + 1;
      }
      const chunks: V4aChunk[] = [];
      let chunk: V4aChunk | null = null;
      let chunkClosed = false; // the last chunk ended with `*** End of File`
      const closeChunk = (): void => {
        if (chunk === null) return;
        // Blank lines at the end of a section are not part of it: drop trailing
        // body entries that came from blank patch lines.
        while (chunk.body.length > 0) {
          const lastEntry = chunk.body[chunk.body.length - 1]!;
          if (lastEntry.kind === 'ctx' && lastEntry.text === '' && (chunk as unknown as { blankTail?: boolean[] }).blankTail?.[chunk.body.length - 1]) {
            chunk.body.pop();
            (chunk as unknown as { blankTail?: boolean[] }).blankTail!.pop();
          } else break;
        }
        chunks.push(chunk);
        chunk = null;
      };
      while (i < end) {
        const l = lines[i]!;
        if (l.startsWith(ADD_PREFIX) || l.startsWith(DELETE_PREFIX) || l.startsWith(UPDATE_PREFIX)) break;
        if (l.trim() === '*** End Patch') break;
        if (l.startsWith('@@')) {
          closeChunk();
          chunk = { anchor: l.slice(2).trim(), eof: false, body: [] };
          (chunk as unknown as { blankTail?: boolean[] }).blankTail = [];
          chunkClosed = false;
          i += 1;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (chunk === null) throw new ParseError(i + 1);
          chunk.eof = true;
          closeChunk();
          chunkClosed = true;
          i += 1;
          continue;
        }
        if (isBlank(l)) {
          if (chunk === null) {
            // A blank line between chunks is ignored.
            i += 1;
            continue;
          }
          chunk.body.push({ kind: 'ctx', text: '' });
          (chunk as unknown as { blankTail?: boolean[] }).blankTail!.push(true);
          i += 1;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (chunk === null) {
            if (chunkClosed) throw new ParseError(i + 1);
            chunk = { anchor: '', eof: false, body: [] };
            (chunk as unknown as { blankTail?: boolean[] }).blankTail = [];
          }
          chunkClosed = false;
          if (l.startsWith(' ')) chunk.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) chunk.body.push({ kind: 'old', text: l.slice(1) });
          else chunk.body.push({ kind: 'new', text: l.slice(1) });
          (chunk as unknown as { blankTail?: boolean[] }).blankTail!.push(false);
          i += 1;
          continue;
        }
        throw new ParseError(i + 1);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new ParseError(headerLine + 1);
      sections.push({ kind: 'update', path, moveTo, chunks });
      continue;
    }
    throw new ParseError(i + 1);
  }

  if (sections.length === 0) throw new ParseError(1);
  return sections.map((s) => v4aEdit(s));
}

function applyV4aChunks(text: string, chunks: V4aChunk[], path: string, strict: boolean): string {
  const file = splitFile(text);
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== '') {
      let foundAt: number | null = null;
      const maxTier = strict ? 0 : 2;
      for (let tier = 0; tier <= maxTier && foundAt === null; tier++) {
        for (let k = cursor; k < file.lines.length; k++) {
          if (linesEqual(chunk.anchor, file.lines[k]!, tier)) {
            foundAt = k;
            break;
          }
        }
      }
      if (foundAt === null) throw new EditFailure('no-match', path);
      cursor = foundAt + 1;
    }
    const olds = oldSide(chunk.body);
    const news = newSide(chunk.body);
    const o = olds.map((b) => b.text);
    if (o.length === 0) {
      const at = chunk.eof ? file.lines.length : cursor;
      file.lines.splice(at, 0, ...news.map((b) => b.text));
      cursor = at + news.length;
    } else {
      const found = findTier(o, file.lines, cursor, strict, chunk.eof ? file.lines.length : undefined);
      if (found === null) throw new EditFailure('no-match', path);
      const pos = found.positions[0]!;
      const repl = buildNewLines(chunk.body, file.lines, pos, found.tier);
      file.lines.splice(pos, o.length, ...repl);
      cursor = pos + repl.length;
    }
  }
  return joinFile(file);
}

function v4aEdit(s: V4aSection): Edit {
  if (s.kind === 'add') {
    return (tree) => {
      requireSafe(s.path);
      if (tree.get(s.path) !== null) throw new EditFailure('exists', s.path);
      tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    return (tree) => {
      requireSafe(s.path);
      if (tree.get(s.path) === null) throw new EditFailure('missing', s.path);
      tree.now.set(s.path, null);
    };
  }
  return (tree) => {
    requireSafe(s.path);
    const before = tree.get(s.path);
    if (before === null) throw new EditFailure('missing', s.path);
    if (s.moveTo !== null) requireSafe(s.moveTo);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new EditFailure('exists', s.moveTo);
    const out = applyV4aChunks(before, s.chunks, s.path, currentStrict());
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, out);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// The run (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  strictFlag = strict;

  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new ParseError(1);
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }

  const tree = new Tree();
  const fails: EditFailure[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }

  // Output rows: one line per path whose state changed, in byte order of the
  // paths (UTF-8). A move that succeeded prints `R <old> -> <new>` (sorted by
  // <new>) instead of its `D` and `A` lines. A path whose bytes are unchanged
  // is not listed.
  const rows: Array<{ key: string; line: string }> = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      movedOld.add(oldP);
      movedNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
