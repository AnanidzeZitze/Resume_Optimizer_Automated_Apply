import path from 'path';
import fs from 'fs';

/**
 * Request-scoped structured logger. One instance per API request.
 * Accumulates log entries in memory and flushes to a timestamped file on completion.
 * Using a per-request instance eliminates any shared global logging state.
 */
export class RunLogger {
  private lines: string[] = [];
  readonly logPath: string;

  constructor(runId?: string) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this.logPath = path.join(process.cwd(), `resume_optimizer_${ts}_${runId ?? 'default'}.log`);
  }

  log(event: string, data?: Record<string, unknown>): void {
    const ts = new Date().toISOString();
    const entry = data
      ? `${ts} [${event}] ${JSON.stringify(data)}`
      : `${ts} [${event}]`;
    this.lines.push(entry);
    console.log(`[OPT] ${event}`, data ?? '');
  }

  async flush(): Promise<void> {
    try {
      await fs.promises.writeFile(this.logPath, this.lines.join('\n') + '\n', 'utf8');
    } catch (e) {
      console.error('[Logger] Failed to write log file:', e);
    }
  }
}
