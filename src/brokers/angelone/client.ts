import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import thirtyTwo from 'thirty-two';
import { BrokerConfig } from '../../types';
import { logger } from '../../utils/logger';

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
      }
    });

    this.setupInterceptors();
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

          logger.warn(`Authentication error (${error.response?.status}), attempting to re-login`);

          const loginSuccess = await this.login();

          if (loginSuccess) {
            logger.info('Re-login successful, retrying request');
            return this.client.request(originalRequest);
          } else {
            logger.error('Re-login failed, request cannot be retried');
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
      const totp = this.generateTOTP(this.config.totpSecret);

      const response = await this.client.post<AngelAuthResponse>('/rest/auth/angelbroking/user/v1/loginByPassword', {
        clientcode: this.config.clientId,
        password: this.config.password,
        totp: totp
      });

      if (response.data.status) {
        this.jwtToken = response.data.data.jwtToken;
        this.refreshToken = response.data.data.refreshToken;
        this.feedToken = response.data.data.feedToken;

        logger.info('Successfully logged in to Angel One');
        logger.audit('LOGIN', { clientId: this.config.clientId, success: true });
        return true;
      } else {
        logger.error('Login failed', response.data);
        logger.audit('LOGIN', { clientId: this.config.clientId, success: false, error: response.data.message });
        return false;
      }
    } catch (error: any) {
      logger.error('Login error', error);
      logger.audit('LOGIN_ERROR', { clientId: this.config.clientId, error: error.message });
      return false;
    }
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
      });

      if (response.data.status && response.data.data) {
        return response.data.data;
      }
      return null;
    } catch (error: any) {
      logger.error('Failed to get market data', error);
      return null;
    }
  }

  public isAuthenticated(): boolean {
    return this.jwtToken !== null;
  }

  public getFeedToken(): string | null {
    return this.feedToken;
  }

  public getAuthToken(): string | null {
    return this.jwtToken;
  }

  public getClientCode(): string {
    return this.config.clientId;
  }
}
