import type { LogLevel, ScriptLanguageId } from '../../types/project';
import { backendRegistry } from '../backends/registry';

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
  return backendRegistry.tryGetDialect(language)?.extractErrorLine?.(message);
}
