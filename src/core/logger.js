/**
 * Small logger: console output in the plugin's canonical `[manager] ...` format
 * plus an in-memory ring buffer that the settings page can display.
 *
 * Never logs API keys, Authorization headers or request payloads.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  /**
   * @param {{ level?: string, maxLines?: number, sink?: (level: string, line: string) => void, prefix?: string }} [options]
   */
  constructor({ level = 'info', maxLines = 500, sink = null, prefix = '[manager]' } = {}) {
    this.level = level in LEVELS ? level : 'info';
    this.maxLines = maxLines;
    this.sink = sink;
    this.prefix = prefix;
    /** @type {{ at: number, level: string, line: string }[]} */
    this.entries = [];
  }

  setLevel(level) {
    if (level in LEVELS) this.level = level;
  }

  debug(line) { this._write('debug', line); }
  info(line) { this._write('info', line); }
  warn(line) { this._write('warn', line); }
  error(line) { this._write('error', line); }

  /** Recent entries, oldest first. */
  recent(limit = 200) {
    return this.entries.slice(-limit);
  }

  _write(level, line) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const text = String(line);
    this.entries.push({ at: Date.now(), level, line: text });
    if (this.entries.length > this.maxLines) {
      this.entries.splice(0, this.entries.length - this.maxLines);
    }
    if (this.sink) {
      try {
        this.sink(level, text);
        return;
      } catch {
        /* fall through to console */
      }
    }
    const rendered = `${this.prefix} ${text}`;
    if (level === 'error') console.error(rendered);
    else if (level === 'warn') console.warn(rendered);
    else console.log(rendered);
  }
}
