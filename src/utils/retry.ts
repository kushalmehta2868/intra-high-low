import { logger } from './logger';

export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  shouldRetry?: (error: any) => boolean;
  onRetry?: (attempt: number, error: any) => void;
  retryableErrors?: string[]; // Error codes or messages that should trigger retry
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: any;
  attempts: number;
  totalDurationMs: number;
}

export class RetryHandler {
  private static defaultOptions: RetryOptions = {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    shouldRetry: (error: any) => true,
    retryableErrors: [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EAI_AGAIN',
      '429', // Rate limit
      '502', // Bad Gateway
      '503', // Service Unavailable
      '504'  // Gateway Timeout
    ]
  };

  /**
   * Executes a function with exponential backoff retry logic
   */
  public static async executeWithRetry<T>(
    fn: () => Promise<T>,
    options?: Partial<RetryOptions>
  ): Promise<RetryResult<T>> {
    const opts = { ...this.defaultOptions, ...options };
    const startTime = Date.now();

    let lastError: any;
    let attempt = 0;

    while (attempt < opts.maxAttempts) {
      attempt++;

      try {
        logger.debug('Executing function', { attempt, maxAttempts: opts.maxAttempts });

        const result = await fn();

        const duration = Date.now() - startTime;

        if (attempt > 1) {
          logger.info('Function succeeded after retry', {
            attempts: attempt,
            totalDurationMs: duration
          });

          logger.audit('RETRY_SUCCESS', {
            attempts: attempt,
            totalDurationMs: duration
          });
        }

        return {
          success: true,
          result: result,
          attempts: attempt,
          totalDurationMs: duration
        };
      } catch (error: any) {
        lastError = error;

        logger.warn('Function execution failed', {
          attempt,
          maxAttempts: opts.maxAttempts,
          error: error.message,
          errorCode: error.code
        });

        // Check if we should retry this error
        const shouldRetry = this.shouldRetryError(error, opts);

        if (!shouldRetry || attempt >= opts.maxAttempts) {
          logger.error('Function failed - no more retries', {
            attempts: attempt,
            error: error.message,
            shouldRetry
          });

          logger.audit('RETRY_FAILED', {
            attempts: attempt,
            error: error.message,
            errorCode: error.code,
            shouldRetry
          });

          return {
            success: false,
            error: lastError,
            attempts: attempt,
            totalDurationMs: Date.now() - startTime
          };
        }

        // Call onRetry callback if provided
        if (opts.onRetry) {
          opts.onRetry(attempt, error);
        }

        // Calculate delay with exponential backoff
        const delay = this.calculateDelay(attempt, opts);

        logger.info('Retrying after delay', {
          attempt,
          nextAttempt: attempt + 1,
          delayMs: delay
        });

        await this.sleep(delay);
      }
    }

    // Should never reach here, but just in case
    return {
      success: false,
      error: lastError,
      attempts: attempt,
      totalDurationMs: Date.now() - startTime
    };
  }

  /**
   * Determines if an error should trigger a retry
   */
  private static shouldRetryError(error: any, options: RetryOptions): boolean {
    // Check custom shouldRetry function
    if (options.shouldRetry && !options.shouldRetry(error)) {
      return false;
    }

    // Check if error code/message is in retryable list
    if (options.retryableErrors) {
      const errorCode = error.code || error.statusCode || '';
      const errorMessage = error.message || '';

      return options.retryableErrors.some(retryableError =>
        errorCode.toString().includes(retryableError) ||
        errorMessage.includes(retryableError)
      );
    }

    return true;
  }

  /**
   * Calculates delay using exponential backoff with jitter
   */
  private static calculateDelay(attempt: number, options: RetryOptions): number {
    const exponentialDelay = options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt - 1);
    const cappedDelay = Math.min(exponentialDelay, options.maxDelayMs);

    // Add jitter (±25% randomness) to prevent thundering herd
    const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);
    const finalDelay = Math.max(0, cappedDelay + jitter);

    return Math.floor(finalDelay);
  }

  /**
   * Sleep utility
   */
  private static sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Decorator for automatic retry on method calls
 */
export function Retry(options?: Partial<RetryOptions>) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const result = await RetryHandler.executeWithRetry(
        () => originalMethod.apply(this, args),
        options
      );

      if (!result.success) {
        throw result.error;
      }

      return result.result;
    };

    return descriptor;
  };
}

/**
 * Simple retry function for quick use
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  delayMs: number = 1000
): Promise<T> {
  const result = await RetryHandler.executeWithRetry(fn, {
    maxAttempts,
    initialDelayMs: delayMs,
    maxDelayMs: delayMs * 10,
    backoffMultiplier: 2
  });

  if (!result.success) {
    throw result.error;
  }

  return result.result!;
}
