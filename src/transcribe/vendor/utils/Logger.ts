/**
 * Centralized logging utility for debug output
 * Provides consistent formatting and conditional output based on debugMode
 */

export enum LogLevel {
	ERROR = 0,
	WARN = 1,
	INFO = 2,
	DEBUG = 3,
	TRACE = 4
}

export interface LoggerConfig {
	debugMode: boolean;
	logLevel: LogLevel;
	prefix?: string;
	forceConsole?: boolean;
}

export class Logger {
	private static readonly MAX_LOG_STRING_LENGTH = 120;
	private static readonly MAX_LOG_KEYS = 80;
	private static readonly MAX_LOG_ARRAY_ITEMS = 80;
	private static readonly MAX_LOG_DEPTH = 6;
	private static readonly SENSITIVE_VALUE_KEYS = new Set<string>([
		'text',
		'transcription',
		'transcript',
		'content',
		'prompt',
		'originalPrompt',
		'previousText',
		'currentText',
		'mergedText',
		'originalText',
		'cleanedText',
		'finalText',
		'segment',
		'segments',
		'raw',
		'body'
	]);

	private static instance: Logger | null = null;
	private config: LoggerConfig = {
		debugMode: false,
		logLevel: LogLevel.INFO,
		prefix: '[AI Transcriber]',
		forceConsole: Logger.shouldForceConsoleOutput()
	};
	private moduleLoggers: Map<string, Logger> = new Map();
	private timers: Map<string, number> = new Map();
	private static readonly MAX_MODULE_LOGGERS = 100; // Prevent unbounded growth

	private constructor(config?: Partial<LoggerConfig>) {
		if (config) {
			this.updateConfig(config);
		}
	}

	/**
	 * Get or create the singleton logger instance
	 */
	static getInstance(config?: Partial<LoggerConfig>): Logger {
		if (!Logger.instance) {
			Logger.instance = new Logger(config);
		} else if (config) {
			Logger.instance.updateConfig(config);
		}
		return Logger.instance;
	}

	/**
	 * Create a logger for a specific module/component
	 */
		static getLogger(moduleName: string): Logger {
			const mainLogger = Logger.getInstance();
			const existing = mainLogger.moduleLoggers.get(moduleName);
			if (existing) {
				return existing;
			}

		// Check size limit to prevent memory leaks
		if (mainLogger.moduleLoggers.size >= Logger.MAX_MODULE_LOGGERS) {
			// Clear oldest entries (first 10) when limit is reached
			const entries = Array.from(mainLogger.moduleLoggers.entries());
			entries.slice(0, 10).forEach(([key]) => {
				mainLogger.moduleLoggers.delete(key);
			});
		}

			const basePrefix = mainLogger.config.prefix ?? '[AI Transcriber]';
			const moduleLogger = new Logger({
				debugMode: mainLogger.config.debugMode,
				logLevel: mainLogger.config.logLevel,
				prefix: `${basePrefix} [${moduleName}]`
			});
			mainLogger.moduleLoggers.set(moduleName, moduleLogger);
			return moduleLogger;
		}

	/**
	 * Update logger configuration
	 */
	updateConfig(config: Partial<LoggerConfig>): void {
		this.config = { ...this.config, ...config };
		// Update all module loggers, preserving their prefixes
		this.moduleLoggers.forEach(logger => {
			logger.updateConfig({
				debugMode: this.config.debugMode,
				logLevel: this.config.logLevel
				// Note: prefix is intentionally not updated to preserve module-specific prefixes
			});
		});
	}

	/**
	 * Check if logging is enabled for a given level
	 */
		private shouldLog(level: LogLevel): boolean {
			if (!this.config.debugMode && !this.config.forceConsole) {
				// In production mode, only show errors and warnings
				return level <= LogLevel.WARN;
			}
			return level <= this.config.logLevel;
		}

	/**
	 * Format the log message with timestamp and prefix
	 */
		private formatMessage(level: LogLevel, message: string): string {
			const iso = new Date().toISOString();
			const timePart = iso.split('T')[1] ?? iso;
			const timestamp = timePart.slice(0, 12);
			const levelName = LogLevel[level];
			const prefix = this.config.prefix ?? '[AI Transcriber]';
			return `${timestamp} ${levelName.padEnd(5)} ${prefix} ${message}`;
		}

	/**
	 * Log an error message
	 */
	error(message: string, error?: unknown): void {
		if (!this.shouldLog(LogLevel.ERROR)) {
			return;
		}
		const formattedMsg = this.formatMessage(LogLevel.ERROR, Logger.sanitizeLogMessage(message));
		if (error instanceof Error) {
			console.error(formattedMsg, Logger.sanitizeLogData(error));
			const stack = Logger.sanitizeErrorStack(error);
			if (stack) {
				console.error('Stack trace:', stack);
			}
			return;
		}
		if (error !== undefined) {
			console.error(formattedMsg, Logger.sanitizeLogData(error));
			return;
		}
		console.error(formattedMsg);
	}

	/**
	 * Log a warning message
	 */
	warn(message: string, data?: unknown): void {
		if (this.shouldLog(LogLevel.WARN)) {
			const formattedMsg = this.formatMessage(LogLevel.WARN, Logger.sanitizeLogMessage(message));
			if (data !== undefined) {
				console.warn(formattedMsg, Logger.sanitizeLogData(data));
			} else {
				console.warn(formattedMsg);
			}
		}
	}

	/**
	 * Log an info message
	 */
	info(message: string, data?: unknown): void {
		if (!this.shouldLog(LogLevel.INFO)) {
			return;
		}
		const formattedMsg = this.formatMessage(LogLevel.INFO, message);
		this.recordLog(LogLevel.INFO, formattedMsg, data);
	}

	/**
	 * Log a debug message
	 */
	debug(message: string, data?: unknown): void {
		if (!this.shouldLog(LogLevel.DEBUG)) {
			return;
		}
		const formattedMsg = this.formatMessage(LogLevel.DEBUG, message);
		this.recordLog(LogLevel.DEBUG, formattedMsg, data);
	}

	/**
	 * Log a trace message (most verbose)
	 */
	trace(message: string, data?: unknown): void {
		if (!this.shouldLog(LogLevel.TRACE)) {
			return;
		}
		const formattedMsg = this.formatMessage(LogLevel.TRACE, message);
		this.recordLog(LogLevel.TRACE, formattedMsg, data);
	}

	/**
	 * Log method entry (for tracing execution flow)
	 */
	enter(methodName: string, params?: unknown): void {
		if (this.shouldLog(LogLevel.TRACE)) {
			const message = `→ ${methodName}`;
			if (params !== undefined) {
				this.trace(message, params);
			} else {
				this.trace(message);
			}
		}
	}

	/**
	 * Log method exit (for tracing execution flow)
	 */
	exit(methodName: string, result?: unknown): void {
		if (this.shouldLog(LogLevel.TRACE)) {
			const message = `← ${methodName}`;
			if (result !== undefined) {
				this.trace(message, result);
			} else {
				this.trace(message);
			}
		}
	}

	/**
	 * Log performance timing
	 */
		time(label: string): void {
			if (!this.shouldLog(LogLevel.DEBUG)) {
				return;
			}
			const prefix = this.config.prefix ?? '[AI Transcriber]';
			const timerKey = `${prefix} ${label}`;
			this.timers.set(timerKey, this.getTimestamp());
		}

	/**
	 * End performance timing
	 */
		timeEnd(label: string): void {
			if (!this.shouldLog(LogLevel.DEBUG)) {
				return;
			}
			const prefix = this.config.prefix ?? '[AI Transcriber]';
			const timerKey = `${prefix} ${label}`;
			const start = this.timers.get(timerKey);
			if (start === undefined) {
				return;
			}
		const duration = this.getTimestamp() - start;
		this.debug(`${label} completed in ${duration.toFixed(2)}ms`);
		this.timers.delete(timerKey);
	}

	/**
	 * Create a scoped logger for a specific operation
	 */
		scope(scopeName: string): Logger {
			const prefix = this.config.prefix ?? '[AI Transcriber]';
			return new Logger({
				debugMode: this.config.debugMode,
				logLevel: this.config.logLevel,
				prefix: `${prefix} [${scopeName}]`
			});
		}

	private recordLog(level: LogLevel, message: string, data?: unknown): void {
		const sanitizedMessage = Logger.sanitizeLogMessage(message);
		const sanitizedData = data !== undefined ? Logger.sanitizeLogData(data) : undefined;

		// Keep lightweight in production; only mirror to console when debugMode is on
		if (this.config.debugMode || this.config.forceConsole) {
			// Restrict to allowed console methods to satisfy lint rules
			// Note: `console.debug` is "Verbose" in Chromium DevTools and can be hidden by default (e.g., Obsidian).
			// Use `console.warn` in browser-like environments for better visibility when debugging.
			const logFn = typeof window !== 'undefined' ? console.warn : console.debug;
			if (sanitizedData !== undefined) {
				logFn(sanitizedMessage, sanitizedData);
			} else {
				logFn(sanitizedMessage);
			}
		}

			// Always buffer logs for in-app inspection
			if (typeof window !== 'undefined') {
				const globalObj = window as Window & { __aiTranscriberLogs?: Array<{ level: LogLevel; message: string; data?: unknown }> };
				globalObj.__aiTranscriberLogs ??= [];
				globalObj.__aiTranscriberLogs.push({ level, message: sanitizedMessage, data: sanitizedData });
			}
		}

	private getTimestamp(): number {
		if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
			return performance.now();
		}
		return Date.now();
	}

	private static shouldForceConsoleOutput(): boolean {
		// Enable console output automatically in Node/CLI (no window)
			if (typeof window === 'undefined') {
				return true;
			}
			// Allow explicit opt-in via environment flag or global toggle for debugging
			const envFlag = typeof process !== 'undefined' && process.env['AI_TRANSCRIBER_FORCE_CONSOLE'] === '1';
			const globalFlag = (window as Window & { __aiTranscriberForceConsole__?: boolean }).__aiTranscriberForceConsole__ === true;
			return envFlag || globalFlag;
		}

	private static sanitizeLogMessage(message: string): string {
		// Defensive: avoid logging very long strings (often accidental transcript fragments).
		if (!message) {
			return message;
		}
		const normalized = message.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
		if (normalized.length <= Logger.MAX_LOG_STRING_LENGTH * 2) {
			return normalized;
		}
		return `<redacted: ${normalized.length} chars>`;
	}

	private static sanitizeLogData(data: unknown): unknown {
		const visited = new WeakSet<object>();
		return Logger.sanitizeLogDataInternal(data, 0, visited);
	}

	private static sanitizeLogDataInternal(data: unknown, depth: number, visited: WeakSet<object>): unknown {
		if (data === null || data === undefined) {
			return data;
		}
		if (depth > Logger.MAX_LOG_DEPTH) {
			return '<redacted: max depth>';
		}

		if (typeof data === 'string') {
			return Logger.sanitizeStringValue(data);
		}
		if (typeof data === 'number' || typeof data === 'boolean' || typeof data === 'bigint') {
			return data;
		}
		if (typeof data === 'symbol') {
			return '<redacted: symbol>';
		}
		if (typeof data === 'function') {
			return '<redacted: function>';
		}

		if (data instanceof Error) {
			return {
				name: data.name,
				message: Logger.sanitizeStringValue(data.message)
			};
		}

		if (Array.isArray(data)) {
			const items = data.slice(0, Logger.MAX_LOG_ARRAY_ITEMS).map(item =>
				Logger.sanitizeLogDataInternal(item, depth + 1, visited)
			);
			if (data.length > Logger.MAX_LOG_ARRAY_ITEMS) {
				items.push(`<truncated: +${data.length - Logger.MAX_LOG_ARRAY_ITEMS} items>`);
			}
			return items;
		}

		if (typeof data === 'object') {
			if (visited.has(data)) {
				return '<redacted: circular>';
			}
			visited.add(data);

			const obj = data as Record<string, unknown>;
			const entries = Object.entries(obj);
			const out: Record<string, unknown> = {};

			for (const [key, value] of entries.slice(0, Logger.MAX_LOG_KEYS)) {
				if (Logger.isSensitiveKey(key)) {
					out[key] = Logger.redactValue(value);
				} else {
					out[key] = Logger.sanitizeLogDataInternal(value, depth + 1, visited);
				}
			}
			if (entries.length > Logger.MAX_LOG_KEYS) {
				out['<truncatedKeys>'] = entries.length - Logger.MAX_LOG_KEYS;
			}
			return out;
		}

		return data;
	}

	private static isSensitiveKey(key: string): boolean {
		// Redact values that are likely to contain user content/transcript fragments.
		// Keep length/count/ratio/etc keys intact for debugging.
		const normalized = key.trim();
		if (!normalized) {
			return false;
		}
		const lower = normalized.toLowerCase();
		if (lower.endsWith('length') ||
			lower.endsWith('count') ||
			lower.endsWith('ratio') ||
			lower.endsWith('size') ||
			lower.endsWith('duration') ||
			lower.endsWith('seconds') ||
			lower.endsWith('ms') ||
			lower.endsWith('index') ||
			lower.endsWith('id')) {
			return false;
		}
		return Logger.SENSITIVE_VALUE_KEYS.has(normalized) || Logger.SENSITIVE_VALUE_KEYS.has(lower);
	}

	private static redactValue(value: unknown): unknown {
		if (typeof value === 'string') {
			return `<redacted: ${value.length} chars>`;
		}
		if (Array.isArray(value)) {
			return `<redacted: array(len=${value.length})>`;
		}
		if (value && typeof value === 'object') {
			return '<redacted: object>';
		}
		return '<redacted>';
	}

	private static sanitizeStringValue(value: string): string {
		const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
		// Multi-line strings frequently indicate user content/transcripts; redact to be safe.
		if (normalized.includes('\n')) {
			return `<redacted: ${normalized.length} chars>`;
		}
		if (normalized.length <= Logger.MAX_LOG_STRING_LENGTH) {
			return normalized;
		}
		return `<redacted: ${normalized.length} chars>`;
	}

	private static sanitizeErrorStack(error: Error): string | null {
		const stack = error.stack;
		if (!stack) {
			return null;
		}

		const normalized = stack.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
		const lines = normalized.split('\n');
		if (lines.length === 0) {
			return null;
		}

		const maxLines = 40;
		const sanitizedMessage = Logger.sanitizeStringValue(error.message);
		const firstLinePrefix = error.name ? `${error.name}:` : 'Error:';
		lines[0] = `${firstLinePrefix} ${sanitizedMessage}`;

		const trimmed = lines.slice(0, maxLines);
		if (lines.length > maxLines) {
			trimmed.push(`<truncated: +${lines.length - maxLines} lines>`);
		}
		return trimmed.join('\n');
	}
}

// Export convenience functions
export const logger = Logger.getInstance();
export const getLogger = (moduleName: string): Logger => Logger.getLogger(moduleName);
