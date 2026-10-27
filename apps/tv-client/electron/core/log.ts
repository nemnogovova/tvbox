import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

/**
 * Mirrors console output of the TV client into <data dir>/logs/tvbox.log (rotated at 2 MB),
 * so problems on the TV PC can be diagnosed after the fact.
 */
export function installFileLog(dir: string): string {
  const logDir = path.join(dir, 'logs');
  const file = path.join(logDir, 'tvbox.log');
  try {
    fs.mkdirSync(logDir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
  } catch {
    return file;
  }
  let size = 0;
  const write = (level: string, args: unknown[]) => {
    const line = `${new Date().toISOString()} ${level} ${format(...args).replace(/\r?\n/g, '\n    ')}\n`;
    size += line.length;
    if (size > 4 * 1024 * 1024) return; // runaway logging: stop rather than fill the disk
    fs.appendFile(file, line, () => undefined);
  };
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      write(level.toUpperCase().padEnd(5), args);
    };
  }
  return file;
}
