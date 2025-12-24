import fs from 'fs';
import path from 'path';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

class Logger {
  private logLevel: LogLevel;
  private logDir: string;
  private auditDir: string;
  private enableFileLogging: boolean;
  private enableAuditLog: boolean;

  constructor(logLevel: string = 'info', enableFileLogging: boolean = false, enableAuditLog: boolean = false) {
    this.logLevel = this.parseLogLevel(logLevel);
    this.enableFileLogging = enableFileLogging;
    this.enableAuditLog = enableAuditLog;
    this.logDir = path.join(process.cwd(), 'logs');
    this.auditDir = path.join(process.cwd(), 'audit');

    // Only create directories if file logging is enabled
    if (this.enableFileLogging || this.enableAuditLog) {
      this.ensureDirectories();
    }
  }

  private parseLogLevel(level: string): LogLevel {
    switch (level.toLowerCase()) {
      case 'debug': return LogLevel.DEBUG;
      case 'info': return LogLevel.INFO;
      case 'warn': return LogLevel.WARN;
      case 'error': return LogLevel.ERROR;
      default: return LogLevel.INFO;
    }
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    if (this.enableAuditLog && !fs.existsSync(this.auditDir)) {
      fs.mkdirSync(this.auditDir, { recursive: true });
    }
  }

  private formatMessage(level: string, message: string, meta?: any): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` | ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level}] ${message}${metaStr}`;
  }

  private writeToFile(filename: string, message: string): void {
    // Skip file writing if file logging is disabled
    if (!this.enableFileLogging) return;

    const filepath = path.join(this.logDir, filename);
    fs.appendFileSync(filepath, message + '\n');
  }

  private log(level: LogLevel, levelName: string, message: string, meta?: any): void {
    if (level < this.logLevel) return;

    const formattedMessage = this.formatMessage(levelName, message, meta);
    console.log(formattedMessage);

    const today = new Date().toISOString().split('T')[0];
    this.writeToFile(`app-${today}.log`, formattedMessage);
  }

  public debug(message: string, meta?: any): void {
    this.log(LogLevel.DEBUG, 'DEBUG', message, meta);
  }

  public info(message: string, meta?: any): void {
    this.log(LogLevel.INFO, 'INFO', message, meta);
  }

  public warn(message: string, meta?: any): void {
    this.log(LogLevel.WARN, 'WARN', message, meta);
  }

  public error(message: string, error?: Error | any): void {
    const meta = error instanceof Error
      ? { message: error.message, stack: error.stack }
      : error;
    this.log(LogLevel.ERROR, 'ERROR', message, meta);
  }

  public audit(event: string, data: any): void {
    // Skip audit logging if disabled
    if (!this.enableAuditLog) return;

    const timestamp = new Date().toISOString();
    const auditEntry = {
      timestamp,
      event,
      data
    };

    // Log to console for visibility
    console.log(`[AUDIT] ${event}:`, JSON.stringify(auditEntry));

    // Only write to file if file logging is enabled
    if (this.enableFileLogging) {
      const today = new Date().toISOString().split('T')[0];
      const auditFile = path.join(this.auditDir, `audit-${today}.jsonl`);
      fs.appendFileSync(auditFile, JSON.stringify(auditEntry) + '\n');
    }
  }
}

export const logger = new Logger();
export default logger;
