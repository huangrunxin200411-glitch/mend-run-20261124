// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** Section 3: a file's lines, its line break and whether it ends with one. */
interface FileLines {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}
function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** Section 5: a line as a tier reads it. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
/** Every 0-based position where O occurs in the file's lines at a tier (overlap allowed). */
function occurrences(fileLines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const nO = O.map((l) => normLine(l, tier));
  for (let i = 0; i + O.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(fileLines[i + j], tier) !== nO[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier at which O occurs at least once, with its positions; null when none. */
function matchTier(fileLines: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(fileLines, O, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}
function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
/** Tier 2 re-indent of one new line: P (O's first line) replaced by F (the file's first matched line). */
function reindentLine(line: string, P: string, F: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (!line.startsWith(P)) return line;
  return F + line.slice(P.length);
}
interface NewLine {
  text: string;
  fromOld: number | null;
}
/** The lines N writes for a match at pos: context lines are the file's own, the rest re-indented at tier 2. */
function buildReplacement(fileLines: string[], O: string[], N: NewLine[], pos: number, tier: number): string[] {
  const F = tier === 2 ? leadingWS(fileLines[pos]) : '';
  const P = tier === 2 ? leadingWS(O[0]) : '';
  return N.map((n) => (n.fromOld !== null ? fileLines[pos + n.fromOld] : tier === 2 ? reindentLine(n.text, P, F) : n.text));
}
/** A file's text after replacing lines [pos, pos+O.length) with the replacement, final break as given. */
function spliceLines(file: FileLines, pos: number, olen: number, repl: string[], final: boolean): FileLines {
  const lines = [...file.lines.slice(0, pos), ...repl, ...file.lines.slice(pos + olen)];
  return { lines, br: file.br, final };
}

/** Section 6: unified diffs. */
interface Hunk {
  a: number;
  oldLines: string[];
  newLines: NewLine[];
  noNLAfterLastCP: boolean;
  noNLAfterLastPlus: boolean;
}
interface Sec {
  gitOld: string | null;
  gitNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  renOld: string | null;
  renNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
function applyHunksToFile(fileText: string, hunks: Hunk[], strict: boolean, path: string): string {
  let file = splitFile(fileText);
  let d = 0;
  for (const h of hunks) {
    const O = h.oldLines;
    const N = h.newLines;
    if (O.length === 0) {
      const insertPos = Math.min(h.a + d, file.lines.length);
      const repl = N.map((n) => n.text);
      const atEnd = insertPos === file.lines.length;
      const newFinal = atEnd ? !h.noNLAfterLastCP : file.final;
      file = spliceLines(file, insertPos, 0, repl, newFinal);
      d += N.length;
    } else {
      const m = matchTier(file.lines, O, strict);
      if (!m) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = m.occ[0];
      let bestDist = Math.abs(best - target);
      for (const pos of m.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const repl = buildReplacement(file.lines, O, N, best, m.tier);
      const atEnd = best + O.length === file.lines.length;
      const newFinal = atEnd ? !h.noNLAfterLastCP : file.final;
      file = spliceLines(file, best, O.length, repl, newFinal);
      d += N.length - O.length;
    }
  }
  return joinFile(file);
}
function unifiedSectionEdit(sec: Sec, strict: boolean, moves: Array<[string, string]>): Edit | null {
  const oldP = sec.dashOld ?? sec.renOld ?? sec.gitOld;
  const newP = sec.dashNew ?? sec.renNew ?? sec.gitNew;
  if (oldP === null && newP === null) return null;
  const oldPath = oldP ?? '/dev/null';
  const newPath = newP ?? '/dev/null';
  const isCreate = sec.isCreate || oldPath === '/dev/null';
  const isDelete = !isCreate && (sec.isDelete || newPath === '/dev/null');
  if (isCreate) {
    return (tree) => {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const content: string[] = [];
      for (const h of sec.hunks) for (const n of h.newLines) if (n.fromOld === null) content.push(n.text);
      let final = true;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi];
        if (h.newLines.some((n) => n.fromOld === null)) {
          final = !h.noNLAfterLastPlus;
          break;
        }
      }
      tree.now.set(newPath, content.length === 0 ? '' : content.join('\n') + (final ? '\n' : ''));
    };
  }
  if (isDelete) {
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
    };
  }
  if (oldPath !== newPath) {
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out = applyHunksToFile(before, sec.hunks, strict, oldPath);
      tree.now.set(newPath, out);
      tree.now.set(oldPath, null);
      moves.push([oldPath, newPath]);
    };
  }
  return (tree) => {
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    tree.now.set(oldPath, applyHunksToFile(before, sec.hunks, strict, oldPath));
  };
}
function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const sections: Sec[] = [];
  let cur: Sec | null = null;
  const newSec = (gitOld: string | null, gitNew: string | null): Sec => {
    const s: Sec = {
      gitOld,
      gitNew,
      dashOld: null,
      dashNew: null,
      renOld: null,
      renNew: null,
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    return s;
  };
  const gitPaths = (line: string, ln: number): [string, string] => {
    const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
    if (!m) throw new Exit2(`error: parse ${ln}`);
    return [m[1], m[2]];
  };
  const parseHunk = (h: number): { hunk: Hunk; next: number } => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[h]);
    if (!m) throw new Exit2(`error: parse ${h + 1}`);
    const a = parseInt(m[1], 10);
    const body: string[] = [];
    let i = h + 1;
    while (i < lines.length) {
      const l = lines[i];
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
        body.push(l);
        i++;
      } else break;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    let lastCP = -1;
    let lastPlus = -1;
    for (let k = 0; k < body.length; k++) {
      const b = body[k];
      if (b.startsWith(' ') || b === '' || b.startsWith('+')) lastCP = k;
      if (b.startsWith('+')) lastPlus = k;
    }
    const noNLAfterLastCP = lastCP >= 0 && body[lastCP + 1] !== undefined && body[lastCP + 1].startsWith('\\');
    const noNLAfterLastPlus = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1].startsWith('\\');
    const oldLines: string[] = [];
    const newLines: NewLine[] = [];
    for (const b of body) {
      if (b.startsWith('\\')) continue;
      if (b.startsWith(' ')) {
        const idx = oldLines.length;
        oldLines.push(b.slice(1));
        newLines.push({ text: b.slice(1), fromOld: idx });
      } else if (b === '') {
        const idx = oldLines.length;
        oldLines.push('');
        newLines.push({ text: '', fromOld: idx });
      } else if (b.startsWith('-')) {
        oldLines.push(b.slice(1));
      } else if (b.startsWith('+')) {
        newLines.push({ text: b.slice(1), fromOld: null });
      }
    }
    return { hunk: { a, oldLines, newLines, noNLAfterLastCP, noNLAfterLastPlus }, next: i };
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (cur === null) {
      if (l.startsWith('diff --git ')) {
        const [gO, gN] = gitPaths(l, i + 1);
        newSec(gO, gN);
        i++;
      } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const s = newSec(null, null);
        s.dashOld = headerPath(l);
        s.dashNew = headerPath(lines[i + 1]);
        i += 2;
      } else if (l.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i++;
      }
    } else if (cur.hunks.length === 0) {
      if (l.startsWith('diff --git ')) {
        const [gO, gN] = gitPaths(l, i + 1);
        newSec(gO, gN);
        i++;
      } else if (l.startsWith('@@')) {
        const { hunk, next } = parseHunk(i);
        cur.hunks.push(hunk);
        i = next;
      } else if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.dashOld = headerPath(l);
          cur.dashNew = headerPath(lines[i + 1]);
          i += 2;
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
      } else if (l.startsWith('+++ ')) {
        cur.dashNew = headerPath(l);
        i++;
      } else if (l.startsWith('rename from ')) {
        if (cur.renOld === null) cur.renOld = l.slice('rename from '.length).trim();
        i++;
      } else if (l.startsWith('rename to ')) {
        if (cur.renNew === null) cur.renNew = l.slice('rename to '.length).trim();
        i++;
      } else if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.isCreate = true;
        i++;
      } else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.isDelete = true;
        i++;
      } else {
        i++;
      }
    } else {
      if (l.startsWith('diff --git ')) {
        const [gO, gN] = gitPaths(l, i + 1);
        newSec(gO, gN);
        i++;
      } else if (l.startsWith('@@')) {
        const { hunk, next } = parseHunk(i);
        cur.hunks.push(hunk);
        i = next;
      } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const s = newSec(null, null);
        s.dashOld = headerPath(l);
        s.dashNew = headerPath(lines[i + 1]);
        i += 2;
      } else {
        i++;
      }
    }
  }
  const edits: Edit[] = [];
  for (const sec of sections) {
    const e = unifiedSectionEdit(sec, strict, moves);
    if (e !== null) edits.push(e);
  }
  return edits;
}

/** Section 7: SEARCH/REPLACE blocks. */
function searchReplaceEdits(lines: string[], strict: boolean, _moves: Array<[string, string]>): Edit[] {
  interface Block {
    path: string;
    searchLine: number;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    // path: nearest line before SEARCH, after prevEnd, not blank and not starting with ```
    let path: string | null = null;
    for (let k = searchIdx - 1; k >= prevEnd; k--) {
      const t = lines[k];
      if (blank(t)) continue;
      const trimmed = t.trim();
      if (trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    // old lines until =======
    let j = searchIdx + 1;
    const oldLines: string[] = [];
    let foundEq = false;
    while (j < lines.length) {
      if (lines[j].trimEnd() === '=======') {
        foundEq = true;
        break;
      }
      oldLines.push(lines[j]);
      j++;
    }
    if (!foundEq) throw new Exit2(`error: parse ${searchIdx + 1}`);
    // new lines until >>>>>>> REPLACE
    let k = j + 1;
    const newLines: string[] = [];
    let foundRep = false;
    while (k < lines.length) {
      if (lines[k].trimEnd() === '>>>>>>> REPLACE') {
        foundRep = true;
        break;
      }
      newLines.push(lines[k]);
      k++;
    }
    if (!foundRep) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, searchLine: searchIdx + 1, oldLines, newLines });
    prevPath = path;
    prevEnd = k + 1;
    i = k + 1;
  }
  return blocks.map((b) => {
    const p = b.path;
    const O = b.oldLines;
    const N: NewLine[] = b.newLines.map((t) => ({ text: t, fromOld: null }));
    if (O.length === 0) {
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, N.length === 0 ? '' : N.map((n) => n.text).join('\n') + '\n');
      };
    }
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const file = splitFile(before);
      const m = matchTier(file.lines, O, strict);
      if (!m) throw new Fail('no-match', p);
      if (m.occ.length > 1) throw new Fail('ambiguous', p);
      const repl = buildReplacement(file.lines, O, N, m.occ[0], m.tier);
      tree.now.set(p, joinFile(spliceLines(file, m.occ[0], O.length, repl, file.final)));
    };
  });
}

/** Section 8: V4A patches. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  oldLines: string[];
  newLines: NewLine[];
}
function applyV4aUpdate(before: string, chunks: VChunk[], strict: boolean, path: string): string {
  let file = splitFile(before);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let found: number | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const nA = normLine(ch.anchor, t);
        for (let k = cursor; k < file.lines.length; k++) {
          if (normLine(file.lines[k], t) === nA) {
            found = k;
            break;
          }
        }
        if (found !== null) break;
      }
      if (found === null) throw new Fail('no-match', path);
      cursor = found + 1;
    }
    const O = ch.oldLines;
    const N = ch.newLines;
    if (O.length === 0) {
      const insertPos = ch.eof ? file.lines.length : cursor;
      const repl = N.map((n) => n.text);
      file = spliceLines(file, insertPos, 0, repl, file.final);
      cursor = insertPos + repl.length;
    } else {
      let chosen: { tier: number; pos: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const occ = occurrences(file.lines, O, t).filter(
          (pos) => pos >= cursor && (!ch.eof || pos + O.length === file.lines.length),
        );
        if (occ.length > 0) {
          chosen = { tier: t, pos: occ[0] };
          break;
        }
      }
      if (!chosen) throw new Fail('no-match', path);
      const repl = buildReplacement(file.lines, O, N, chosen.pos, chosen.tier);
      file = spliceLines(file, chosen.pos, O.length, repl, file.final);
      cursor = chosen.pos + repl.length;
    }
  }
  return joinFile(file);
}
function parseV4aChunks(bodyLines: string[], bodyStartLineNo: number): VChunk[] {
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; body: string[] } | null = null;
  const buildChunk = (c: { anchor: string | null; eof: boolean; body: string[] }): VChunk => {
    const oldLines: string[] = [];
    const newLines: NewLine[] = [];
    for (const b of c.body) {
      if (b.startsWith(' ')) {
        const idx = oldLines.length;
        oldLines.push(b.slice(1));
        newLines.push({ text: b.slice(1), fromOld: idx });
      } else if (b === '') {
        const idx = oldLines.length;
        oldLines.push('');
        newLines.push({ text: '', fromOld: idx });
      } else if (b.startsWith('-')) {
        oldLines.push(b.slice(1));
      } else if (b.startsWith('+')) {
        newLines.push({ text: b.slice(1), fromOld: null });
      }
    }
    return { anchor: c.anchor, eof: c.eof, oldLines, newLines };
  };
  const pushCur = () => {
    if (cur) {
      chunks.push(buildChunk(cur));
      cur = null;
    }
  };
  for (let k = 0; k < bodyLines.length; k++) {
    const l = bodyLines[k];
    const ln = bodyStartLineNo + k;
    if (l.startsWith('@@')) {
      pushCur();
      const anchorText = l.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
    } else if (l.trim() === '*** End of File') {
      if (!cur) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      pushCur();
    } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (!cur) {
        if (chunks.length === 0) {
          cur = { anchor: null, eof: false, body: [] };
        } else {
          throw new Exit2(`error: parse ${ln}`);
        }
      }
      cur.body.push(l);
    } else {
      throw new Exit2(`error: parse ${ln}`);
    }
  }
  pushCur();
  return chunks;
}
function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface RawSec {
    kind: 'add' | 'delete' | 'update';
    path: string;
    lineNo: number;
    start: number;
  }
  const headers: RawSec[] = [];
  for (let k = first + 1; k < last; k++) {
    const l = lines[k];
    if (l.startsWith('*** Add File: ')) {
      headers.push({ kind: 'add', path: l.slice('*** Add File: '.length).trim(), lineNo: k + 1, start: k + 1 });
    } else if (l.startsWith('*** Delete File: ')) {
      headers.push({ kind: 'delete', path: l.slice('*** Delete File: '.length).trim(), lineNo: k + 1, start: k + 1 });
    } else if (l.startsWith('*** Update File: ')) {
      headers.push({ kind: 'update', path: l.slice('*** Update File: '.length).trim(), lineNo: k + 1, start: k + 1 });
    } else if (blank(l)) {
      continue;
    } else if (headers.length === 0) {
      throw new Exit2(`error: parse ${k + 1}`);
    }
  }
  const edits: Edit[] = [];
  for (let s = 0; s < headers.length; s++) {
    const sec = headers[s];
    const end = s + 1 < headers.length ? headers[s + 1].start - 1 : last;
    const body = lines.slice(sec.start, end);
    while (body.length > 0 && blank(body[body.length - 1])) body.pop();
    if (sec.kind === 'add') {
      const content: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const b = body[k];
        if (b.startsWith('+')) content.push(b.slice(1));
        else if (b === '') content.push('');
        else throw new Exit2(`error: parse ${sec.start + k + 1}`);
      }
      const p = sec.path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content.length === 0 ? '' : content.join('\n') + '\n');
      });
    } else if (sec.kind === 'delete') {
      for (let k = 0; k < body.length; k++) {
        if (!blank(body[k])) throw new Exit2(`error: parse ${sec.start + k + 1}`);
      }
      const p = sec.path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let idx = 0;
      while (idx < body.length && blank(body[idx])) idx++;
      let moveTo: string | null = null;
      if (idx < body.length && body[idx].startsWith('*** Move to: ')) {
        moveTo = body[idx].slice('*** Move to: '.length).trim();
        idx++;
      }
      const chunkLines = body.slice(idx);
      const chunks = parseV4aChunks(chunkLines, sec.start + idx + 1);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
      const p = sec.path;
      const mv = moveTo;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const out = applyV4aUpdate(before, chunks, strict, p);
        if (mv !== null) {
          tree.now.set(mv, out);
          tree.now.set(p, null);
          moves.push([p, mv]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
  }
  return edits;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

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
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict, moves);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rRows: Array<{ key: string; line: string }> = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of moves) {
    const oldC = changed.get(oldP);
    const newC = changed.get(newP);
    if (oldC && oldC.was !== null && oldC.now === null && newC && newC.was === null && newC.now !== null) {
      rRows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const [p, c] of changed) {
    if (consumed.has(p)) continue;
    const tag = c.was === null ? 'A' : c.now === null ? 'D' : 'M';
    rows.push({ key: p, line: `${tag} ${p}` });
  }
  rows.push(...rRows);
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of tree.now.keys()) {
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
