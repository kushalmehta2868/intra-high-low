import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import thirtyTwo from 'thirty-two';
import { BrokerConfig } from '../../types';
import { logger } from '../../utils/logger';
import { authStateManager } from '../../services/authStateManager';

interface AngelAuthResponse {
  status: boolean;
  message: string;
  errorcode: string;
  data: {
    jwtToken: string;
    refreshToken: string;
    feedToken: string;
  };
}

interface AngelOrderRequest {
  variety: string;
  tradingsymbol: string;
  symboltoken: string;
  transactiontype: 'BUY' | 'SELL';
  exchange: string;
  ordertype: 'MARKET' | 'LIMIT' | 'STOPLOSS_LIMIT' | 'STOPLOSS_MARKET';
  producttype: 'INTRADAY' | 'DELIVERY' | 'MARGIN';
  duration: 'DAY' | 'IOC';
  price: string;
  squareoff: string;
  stoploss: string;
  quantity: string;
}

interface AngelOrderResponse {
  status: boolean;
  message: string;
  errorcode: string;
  data: {
    orderid: string;
  };
}

export class AngelOneClient {
  private client: AxiosInstance;
  private config: BrokerConfig;
  private jwtToken: string | null = null;
  private refreshToken: string | null = null;
  private feedToken: string | null = null;
  private baseURL = 'https://apiconnect.angelbroking.com';

  // Rate limiting & backoff state
  private loginAttempts: number = 0;
  private lastLoginAttempt: number = 0;
  private loginCooldownUntil: number = 0;
  private readonly MAX_LOGIN_ATTEMPTS = 3;
  private readonly LOGIN_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
  private readonly MIN_LOGIN_INTERVAL_MS = 10 * 1000; // 10 seconds between attempts

  // Token expiry tracking
  private tokenExpiresAt: number = 0;
  private readonly TOKEN_VALIDITY_MS = 4 * 60 * 60 * 1000; // 4 hours (conservative estimate)

  constructor(config: BrokerConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MacAddress': '00:00:00:00:00:00',
        'X-PrivateKey': config.apiKey
      },
      timeout: 30000 // 30 second timeout
    });

    this.setupInterceptors();
    this.loadPersistedState();
  }

  /**
   * Load persisted authentication state from disk
   */
  private loadPersistedState(): void {
    const state = authStateManager.loadState();
    if (state) {
      this.loginAttempts = state.loginAttempts;
      this.loginCooldownUntil = state.loginCooldownUntil;

      if (Date.now() < this.loginCooldownUntil) {
        const remainingMin = Math.ceil((this.loginCooldownUntil - Date.now()) / 60000);
        logger.warn('⚠️ Restored login cooldown from previous session', {
          remainingMinutes: remainingMin
        });
      }
    }
  }

  /**
   * Save authentication state to disk
   */
  private savePersistedState(): void {
    authStateManager.saveState(this.loginAttempts, this.loginCooldownUntil);
  }

  private setupInterceptors(): void {
    this.client.interceptors.request.use(
      (config) => {
        if (this.jwtToken) {
          config.headers['Authorization'] = `Bearer ${this.jwtToken}`;
        }
        return config;
      },
      (error) => {
        logger.error('Request interceptor error', error);
        return Promise.reject(error);
      }
    );

    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;

        // Handle 401 (Unauthorized) or 403 (Forbidden) - both indicate auth issues
        if ((error.response?.status === 401 || error.response?.status === 403) && !originalRequest._retry) {
          originalRequest._retry = true; // Prevent infinite retry loop

          logger.warn(`Authentication error (${error.response?.status}), attempting token refresh`);

          // Try token refresh first (faster, doesn't use TOTP)
          let authSuccess = await this.refreshJWTToken();

          // If refresh fails, try full re-login as fallback
          if (!authSuccess) {
            logger.warn('Token refresh failed, attempting full re-login');
            authSuccess = await this.login();
          }

          if (authSuccess) {
            logger.info('Authentication recovered, retrying request');
            return this.client.request(originalRequest);
          } else {
            logger.error('Authentication recovery failed, request cannot be retried');
          }
        }
        return Promise.reject(error);
      }
    );
  }

  private generateTOTP(secret: string): string {
    const epoch = Math.round(Date.now() / 1000.0);
    const time = Math.floor(epoch / 30);
    const timeHex = time.toString(16).padStart(16, '0');
    const timeBuffer = Buffer.from(timeHex, 'hex');

    const decodedSecret = thirtyTwo.decode(secret);
    const hmac = crypto.createHmac('sha1', Buffer.from(decodedSecret));
    hmac.update(timeBuffer);
    const hash = hmac.digest();

    const offset = hash[hash.length - 1] & 0x0f;
    const binary = ((hash[offset] & 0x7f) << 24) |
                   ((hash[offset + 1] & 0xff) << 16) |
                   ((hash[offset + 2] & 0xff) << 8) |
                   (hash[offset + 3] & 0xff);

    const otp = binary % 1000000;
    return otp.toString().padStart(6, '0');
  }

  public async login(): Promise<boolean> {
    try {
      // Check if we're in cooldown period
      const now = Date.now();
      if (now < this.loginCooldownUntil) {
        const remainingMs = this.loginCooldownUntil - now;
        const remainingMin = Math.ceil(remainingMs / 60000);
        logger.warn(`🚫 Login blocked - in cooldown period`, {
          remainingMinutes: remainingMin,
          reason: 'Too many failed login attempts - preventing IP block'
        });
        return false;
      }

      // Enforce minimum interval between login attempts
      const timeSinceLastAttempt = now - this.lastLoginAttempt;
      if (timeSinceLastAttempt < this.MIN_LOGIN_INTERVAL_MS && this.lastLoginAttempt > 0) {
        const waitMs = this.MIN_LOGIN_INTERVAL_MS - timeSinceLastAttempt;
        logger.info(`⏳ Waiting ${Math.ceil(waitMs / 1000)}s before login attempt (rate limiting)`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }

      this.lastLoginAttempt = Date.now();
      const totp = this.generateTOTP(this.config.totpSecret);

      logger.info('🔐 Attempting login to Angel One', {
        clientId: this.config.clientId,
        attempt: this.loginAttempts + 1,
        maxAttempts: this.MAX_LOGIN_ATTEMPTS
      });

      const response = await this.client.post<AngelAuthResponse>('/rest/auth/angelbroking/user/v1/loginByPassword', {
        clientcode: this.config.clientId,
        password: this.config.password,
        totp: totp
      });

      if (response.data.status) {
        this.jwtToken = response.data.data.jwtToken;
        this.refreshToken = response.data.data.refreshToken;
        this.feedToken = response.data.data.feedToken;
        this.tokenExpiresAt = Date.now() + this.TOKEN_VALIDITY_MS;

        // Reset failure counters on success
        this.loginAttempts = 0;
        this.loginCooldownUntil = 0;

        // Clear persisted state on successful login
        authStateManager.clearState();

        logger.info('✅ Successfully logged in to Angel One', {
          tokenExpiresAt: new Date(this.tokenExpiresAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
        });
        logger.audit('LOGIN', { clientId: this.config.clientId, success: true });
        return true;
      } else {
        this.handleLoginFailure(response.data.message, response.data.errorcode);
        logger.error('❌ Login failed', {
          message: response.data.message,
          errorCode: response.data.errorcode
        });
        logger.audit('LOGIN', { clientId: this.config.clientId, success: false, error: response.data.message });
        return false;
      }
    } catch (error: any) {
      const statusCode = error.response?.status;
      const errorMessage = error.response?.data?.message || error.message;
      const errorCode = error.response?.data?.errorcode;

      this.handleLoginFailure(errorMessage, errorCode, statusCode);

      logger.error('❌ Login error', {
        statusCode,
        message: errorMessage,
        errorCode,
        isAxiosError: error.isAxiosError,
        response: error.response?.data
      });
      logger.audit('LOGIN_ERROR', {
        clientId: this.config.clientId,
        error: errorMessage,
        statusCode
      });
      return false;
    }
  }

  /**
   * Handle login failure with exponential backoff
   */
  private handleLoginFailure(message: string, errorCode?: string, statusCode?: number): void {
    this.loginAttempts++;

    if (statusCode === 403 || statusCode === 401) {
      logger.error('🚨 Authentication rejected by Angel One', {
        statusCode,
        message,
        errorCode,
        possibleCauses: [
          'Invalid API credentials (check ANGEL_API_KEY, ANGEL_CLIENT_ID, ANGEL_PASSWORD)',
          'Incorrect TOTP secret (use base32 secret, not 6-digit code)',
          'API access not enabled on Angel One account',
          'IP address blocked by Angel One (rate limiting)',
          'Account locked or suspended'
        ]
      });
    }

    if (this.loginAttempts >= this.MAX_LOGIN_ATTEMPTS) {
      this.loginCooldownUntil = Date.now() + this.LOGIN_COOLDOWN_MS;
      const cooldownMin = this.LOGIN_COOLDOWN_MS / 60000;

      logger.error(`🚨 Maximum login attempts reached (${this.MAX_LOGIN_ATTEMPTS})`, {
        cooldownMinutes: cooldownMin,
        action: 'Entering cooldown period to prevent IP block',
        nextAttemptAt: new Date(this.loginCooldownUntil).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
      });

      // Save state to survive restarts
      this.savePersistedState();
    } else {
      // Save attempts count after each failure
      this.savePersistedState();
    }
  }

  /**
   * Refresh JWT token using refresh token (avoids full re-login)
   */
  private async refreshJWTToken(): Promise<boolean> {
    try {
      if (!this.refreshToken) {
        logger.warn('No refresh token available - must perform full login');
        return false;
      }

      logger.info('🔄 Refreshing JWT token using refresh token');

      const response = await this.client.post<AngelAuthResponse>('/rest/auth/angelbroking/jwt/v1/generateTokens', {
        refreshToken: this.refreshToken
      });

      if (response.data.status) {
        this.jwtToken = response.data.data.jwtToken;
        this.feedToken = response.data.data.feedToken;
        this.tokenExpiresAt = Date.now() + this.TOKEN_VALIDITY_MS;

        logger.info('✅ JWT token refreshed successfully');
        return true;
      } else {
        logger.warn('Token refresh failed - will attempt full re-login', {
          message: response.data.message
        });
        return false;
      }
    } catch (error: any) {
      logger.warn('Token refresh error - will attempt full re-login', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Check if token is about to expire and refresh if needed
   */
  private async ensureValidToken(): Promise<boolean> {
    const now = Date.now();
    const timeUntilExpiry = this.tokenExpiresAt - now;
    const refreshThreshold = 15 * 60 * 1000; // Refresh 15 minutes before expiry

    // Token is still valid
    if (timeUntilExpiry > refreshThreshold) {
      return true;
    }

    // Token is close to expiry or expired - try to refresh
    logger.info('⏰ Token expiring soon - attempting refresh', {
      expiresIn: `${Math.floor(timeUntilExpiry / 60000)} minutes`
    });

    const refreshed = await this.refreshJWTToken();
    if (refreshed) {
      return true;
    }

    // Refresh failed - try full re-login as fallback
    logger.warn('Token refresh failed - attempting full re-login');
    return await this.login();
  }

  public async placeOrder(orderRequest: AngelOrderRequest): Promise<string | null> {
    try {
      const response = await this.client.post<AngelOrderResponse>(
        '/rest/secure/angelbroking/order/v1/placeOrder',
        orderRequest
      );

      if (response.data.status) {
        const orderId = response.data.data.orderid;
        logger.info('Order placed successfully', { orderId, symbol: orderRequest.tradingsymbol });
        logger.audit('ORDER_PLACED', { orderId, orderRequest });
        return orderId;
      } else {
        logger.error('Order placement failed', response.data);
        logger.audit('ORDER_FAILED', { orderRequest, error: response.data.message });
        return null;
      }
    } catch (error: any) {
      logger.error('Order placement error', error);
      logger.audit('ORDER_ERROR', { orderRequest, error: error.message });
      return null;
    }
  }

  public async cancelOrder(orderId: string, variety: string = 'NORMAL'): Promise<boolean> {
    try {
      const response = await this.client.post(
        '/rest/secure/angelbroking/order/v1/cancelOrder',
        {
          variety: variety,
          orderid: orderId
        }
      );

      if (response.data.status) {
        logger.info('Order cancelled successfully', { orderId });
        logger.audit('ORDER_CANCELLED', { orderId });
        return true;
      } else {
        logger.error('Order cancellation failed', response.data);
        return false;
      }
    } catch (error: any) {
      logger.error('Order cancellation error', error);
      return false;
    }
  }

  public async getProfile(): Promise<any> {
    try {
      const response = await this.client.get('/rest/secure/angelbroking/user/v1/getProfile');
      return response.data.data;
    } catch (error: any) {
      logger.error('Failed to get profile', error);
      return null;
    }
  }

  public async getRMS(): Promise<any> {
    try {
      const response = await this.client.get('/rest/secure/angelbroking/user/v1/getRMS');
      return response.data.data;
    } catch (error: any) {
      logger.error('Failed to get RMS data', error);
      return null;
    }
  }

  public async getOrderBook(): Promise<any[]> {
    try {
      const response = await this.client.get('/rest/secure/angelbroking/order/v1/getOrderBook');
      return response.data.data || [];
    } catch (error: any) {
      logger.error('Failed to get order book', error);
      return [];
    }
  }

  public async getPositions(): Promise<any[]> {
    try {
      const response = await this.client.get('/rest/secure/angelbroking/order/v1/getPosition');
      return response.data.data || [];
    } catch (error: any) {
      logger.error('Failed to get positions', error);
      return [];
    }
  }

  public async getLTP(exchange: string, tradingSymbol: string, symbolToken: string): Promise<number | null> {
    try {
      const response = await this.client.post('/rest/secure/angelbroking/order/v1/getLtpData', {
        exchange: exchange,
        tradingsymbol: tradingSymbol,
        symboltoken: symbolToken
      });

      if (response.data.status && response.data.data) {
        return parseFloat(response.data.data.ltp);
      }
      return null;
    } catch (error: any) {
      logger.error('Failed to get LTP', error);
      return null;
    }
  }

  public async getMarketData(mode: 'FULL' | 'OHLC' | 'LTP', exchangeTokens: { [key: string]: string[] }): Promise<any> {
    try {
      const response = await this.client.post('/rest/secure/angelbroking/market/v1/quote', {
        mode: mode,
        exchangeTokens: exchangeTokens
      }, {
        timeout: 30000 // 30 second timeout - increased for cloud deployment with network latency
      });

      if (response.data.status && response.data.data) {
        return response.data.data;
      }

      // Log when API returns status=false
      if (!response.data.status) {
        logger.debug('Market data API returned status=false', {
          message: response.data.message,
          errorcode: response.data.errorcode
        });
      }

      return null;
    } catch (error: any) {
      // Don't spam errors for common network issues
      const isNetworkError = error.code === 'ECONNRESET' ||
                            error.code === 'ETIMEDOUT' ||
                            error.code === 'ENOTFOUND' ||
                            error.message?.includes('timeout');

      if (isNetworkError) {
        logger.debug('Network error fetching market data', {
          error: error.message,
          code: error.code
        });
      } else {
        logger.error('Failed to get market data', {
          error: error.message,
          code: error.code
        });
      }

      return null;
    }
  }

  public isAuthenticated(): boolean {
    return this.jwtToken !== null;
  }

  public getFeedToken(): string | null {
    return this.feedToken;
  }

  /**
   * Reset login cooldown - use after fixing credentials or waiting for IP unblock
   */
  public resetLoginCooldown(): void {
    this.loginAttempts = 0;
    this.loginCooldownUntil = 0;
    this.lastLoginAttempt = 0;
    logger.info('✅ Login cooldown reset - ready for new login attempts');
  }

  /**
   * Get login status information
   */
  public getLoginStatus(): {
    isAuthenticated: boolean;
    loginAttempts: number;
    isInCooldown: boolean;
    cooldownRemainingMs: number;
  } {
    const now = Date.now();
    const isInCooldown = now < this.loginCooldownUntil;
    const cooldownRemainingMs = isInCooldown ? this.loginCooldownUntil - now : 0;

    return {
      isAuthenticated: this.isAuthenticated(),
      loginAttempts: this.loginAttempts,
      isInCooldown,
      cooldownRemainingMs
    };
  }

  public getAuthToken(): string | null {
    return this.jwtToken;
  }

  public getClientCode(): string {
    return this.config.clientId;
  }
}
