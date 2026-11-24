import type { ScriptLanguageId } from '../types/project';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const LUA_KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return',
  'then', 'true', 'until', 'while',
]);

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

const BUILTIN_FUNCS = new Set([
  'print', 'tostring', 'tonumber', 'pairs', 'ipairs', 'len', 'str', 'int',
  'float', 'range', 'list', 'dict', 'abs', 'round', 'min', 'max', 'sum',
  'table', 'math', 'random',
]);

/**
 * Lightweight, dependency-free syntax highlighter for Lua & Python lines.
 */
export function highlightCodeLine(line: string, lang: ScriptLanguageId): string {
  if (!line) return '&nbsp;';

  const commentPrefix = lang === 'lua' ? '--' : '#';
  const keywords = lang === 'lua' ? LUA_KEYWORDS : PYTHON_KEYWORDS;

  const tokens: string[] = [];
  let i = 0;

  while (i < line.length) {
    // Comment to end of line
    if (line.startsWith(commentPrefix, i)) {
      tokens.push(`<span class="syn-cmt">${escapeHtml(line.slice(i))}</span>`);
      break;
    }

    // Quoted string
    if (line[i] === '"' || line[i] === "'") {
      const quote = line[i];
      let j = i + 1;
      while (j < line.length && line[j] !== quote) {
        if (line[j] === '\\') j++;
        j++;
      }
      j = Math.min(line.length, j + 1);
      tokens.push(`<span class="syn-str">${escapeHtml(line.slice(i, j))}</span>`);
      i = j;
      continue;
    }

    // Number literal
    if (/\d/.test(line[i]) && (i === 0 || !/[a-zA-Z0-9_]/.test(line[i - 1]))) {
      let j = i;
      while (j < line.length && /[\d.]/.test(line[j])) j++;
      tokens.push(`<span class="syn-num">${escapeHtml(line.slice(i, j))}</span>`);
      i = j;
      continue;
    }

    // Identifier / keyword / function call
    if (/[a-zA-Z_]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[a-zA-Z0-9_]/.test(line[j])) j++;
      const word = line.slice(i, j);
      const nextChar = line[j];
      if (keywords.has(word)) {
        tokens.push(`<span class="syn-kw">${escapeHtml(word)}</span>`);
      } else if (BUILTIN_FUNCS.has(word) || nextChar === '(') {
        tokens.push(`<span class="syn-fn">${escapeHtml(word)}</span>`);
      } else {
        tokens.push(escapeHtml(word));
      }
      i = j;
      continue;
    }

    tokens.push(escapeHtml(line[i]));
    i++;
  }

  return tokens.join('');
}
