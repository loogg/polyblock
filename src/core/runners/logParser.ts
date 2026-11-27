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

const ERROR_LINE_EXTRACTORS: Record<
  ScriptLanguageId,
  (message: string) => number | undefined
> = {
  lua: (message) => {
    // e.g. [string "..."]:7: attempt to perform arithmetic...
    const m = /\[string[^\]]*\]:(\d+):/.exec(message) ?? /:(\d+):/.exec(message);
    return m ? Number(m[1]) : undefined;
  },
  python: (message) => {
    // Python traceback: File "<string>", line 7, in <module>
    const matches = Array.from(message.matchAll(/line\s+(\d+)/gi));
    return matches.length > 0
      ? Number(matches[matches.length - 1][1])
      : undefined;
  },
};

export function extractErrorLine(
  message: string,
  language: ScriptLanguageId,
): number | undefined {
  return ERROR_LINE_EXTRACTORS[language](message);
}
