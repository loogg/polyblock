import type { LogLevel, ScriptLanguageId } from '../../types/project';

export interface ParsedOutputLine {
  level: LogLevel;
  message: string;
}

const LEVEL_PREFIX_RE = /^\[(INFO|WARN|ERROR|OK)\]\s?(.*)$/;

export function parseStdoutLine(rawLine: string): ParsedOutputLine {
  const match = LEVEL_PREFIX_RE.exec(rawLine);
  if (match) {
    const tag = match[1].toLowerCase() as 'info' | 'warn' | 'error' | 'ok';
    return { level: tag, message: match[2] };
  }

  return { level: 'print', message: rawLine };
}

export function extractErrorLine(
  message: string,
  language: ScriptLanguageId,
): number | undefined {
  if (language === 'lua') {
    // e.g. [string "..."]:7: attempt to perform arithmetic...
    const m = /\[string[^\]]*\]:(\d+):/.exec(message) ?? /:(\d+):/.exec(message);
    if (m) return Number(m[1]);
    return undefined;
  }

  // Python traceback: File "<string>", line 7, in <module>
  const matches = Array.from(message.matchAll(/line\s+(\d+)/gi));
  if (matches.length > 0) {
    return Number(matches[matches.length - 1][1]);
  }
  return undefined;
}
