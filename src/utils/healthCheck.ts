import http from 'http';
import { logger } from './logger';

interface HealthStatus {
  isHealthy: boolean;
  engineRunning: boolean;
  authCooldown: boolean;
  reconnecting: boolean;
  lastUpdate: Date;
  uptime: number;
}

/**
 * Simple HTTP health check server for Render.com
 * Prevents Render from restarting the service unnecessarily
 */
export class HealthCheckServer {
  private server: http.Server | null = null;
  private port: number;
  private status: HealthStatus = {
    isHealthy: true,
    engineRunning: false,
    authCooldown: false,
    reconnecting: false,
    lastUpdate: new Date(),
    uptime: 0
  };
  private startTime: number = Date.now();

  constructor(port?: number) {
    // Use PORT from environment (Render sets this automatically)
    // Otherwise use provided port or default to 10000
    this.port = port || parseInt(process.env.PORT || '10000');
  }

  /**
   * Start the health check server
   */
  public start(): void {
    if (this.server) {
      logger.warn('Health check server already running');
      return;
    }

    this.server = http.createServer((req, res) => {
      // Update uptime
      this.status.uptime = Math.floor((Date.now() - this.startTime) / 1000);

      if (req.url === '/health' || req.url === '/') {
        // CRITICAL: Return 200 even during auth cooldown or reconnection
        // These are temporary states, not fatal errors
        // Only return 503 for true failures
        const isOperational = this.status.isHealthy ||
                             this.status.authCooldown ||
                             this.status.reconnecting;
        const statusCode = isOperational ? 200 : 503;

        res.writeHead(statusCode, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        });

        const healthInfo = {
          status: statusCode === 200 ? 'healthy' : 'unhealthy',
          engineRunning: this.status.engineRunning,
          authCooldown: this.status.authCooldown,
          reconnecting: this.status.reconnecting,
          uptime: this.status.uptime,
          lastUpdate: this.status.lastUpdate.toISOString(),
          timestamp: new Date().toISOString(),
          message: this.status.authCooldown
            ? 'Authentication cooldown active - will retry soon'
            : this.status.reconnecting
            ? 'Attempting to reconnect to broker'
            : statusCode === 200
            ? 'All systems operational'
            : 'Service degraded'
        };

        res.end(JSON.stringify(healthInfo, null, 2));
      } else {
        // 404 for other routes
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    this.server.listen(this.port, () => {
      logger.info(`✅ Health check server started on port ${this.port}`);
      logger.info(`   Health endpoint: http://localhost:${this.port}/health`);
    });

    // Handle server errors
    this.server.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        logger.warn(`Port ${this.port} is already in use, health check disabled`);
      } else {
        logger.error('Health check server error', error);
      }
    });
  }

  /**
   * Update health status
   */
  public updateStatus(isHealthy: boolean, engineRunning: boolean): void {
    this.status.isHealthy = isHealthy;
    this.status.engineRunning = engineRunning;
    this.status.lastUpdate = new Date();
  }

  /**
   * Mark as healthy
   */
  public setHealthy(): void {
    this.status.isHealthy = true;
    this.status.lastUpdate = new Date();
  }

  /**
   * Mark as unhealthy
   */
  public setUnhealthy(): void {
    this.status.isHealthy = false;
    this.status.lastUpdate = new Date();
  }

  /**
   * Update engine running status
   */
  public setEngineRunning(running: boolean): void {
    this.status.engineRunning = running;
    this.status.lastUpdate = new Date();
  }

  /**
   * Set authentication cooldown status
   */
  public setAuthCooldown(inCooldown: boolean): void {
    this.status.authCooldown = inCooldown;
    // Service is still healthy during cooldown - just waiting
    if (inCooldown) {
      this.status.isHealthy = true;
    }
    this.status.lastUpdate = new Date();
  }

  /**
   * Set reconnecting status
   */
  public setReconnecting(reconnecting: boolean): void {
    this.status.reconnecting = reconnecting;
    // Service is still healthy while reconnecting
    if (reconnecting) {
      this.status.isHealthy = true;
    }
    this.status.lastUpdate = new Date();
  }

  /**
   * Stop the health check server
   */
  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        logger.info('Health check server stopped');
        this.server = null;
        resolve();
      });

      // Force close after 5 seconds
      setTimeout(() => {
        if (this.server) {
          this.server = null;
          resolve();
        }
      }, 5000);
    });
  }
}

// Export singleton instance
export const healthCheckServer = new HealthCheckServer();
