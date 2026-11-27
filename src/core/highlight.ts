import type { ScriptLanguageId } from '../types/project';
import { backendRegistry } from './backends/registry';
import type { LanguageDialect } from './backends/types';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const DIALECT_TOKEN_CACHE = new WeakMap<
  LanguageDialect,
  { keywords: Set<string>; builtins: Set<string> }
>();

const EMPTY_SET = new Set<string>();

function getDialectTokenSets(dialect: LanguageDialect | undefined): {
  keywords: Set<string>;
  builtins: Set<string>;
} {
  if (!dialect) {
    return { keywords: EMPTY_SET, builtins: EMPTY_SET };
  }
  let cached = DIALECT_TOKEN_CACHE.get(dialect);
  if (!cached) {
    cached = {
      keywords: new Set(dialect.keywords),
      builtins: new Set(dialect.builtinFuncs ?? []),
    };
    DIALECT_TOKEN_CACHE.set(dialect, cached);
  }
  return cached;
}

/**
 * Lightweight, dependency-free syntax highlighter driven solely by registered `LanguageDialect`s.
 */
export function highlightCodeLine(line: string, lang: ScriptLanguageId): string {
  if (!line) return '&nbsp;';

  const dialect = backendRegistry.tryGetDialect(lang);
  const commentPrefix = dialect?.commentToken ?? '//';
  const { keywords, builtins } = getDialectTokenSets(dialect);

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
      } else if (builtins.has(word) || nextChar === '(') {
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
