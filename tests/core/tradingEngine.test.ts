import { TradingEngine } from '../../src/core/tradingEngine';
import { AppConfig, TradingMode, OrderSide } from '../../src/types';
import { marginChecker } from '../../src/services/marginChecker';
import { orderIdempotencyManager } from '../../src/services/orderIdempotency';
import { positionLockManager } from '../../src/utils/positionLock';

// Mock Dependencies
jest.mock('../../src/services/marginChecker');
jest.mock('../../src/services/orderIdempotency');
jest.mock('../../src/telegram/bot');
jest.mock('../../src/brokers/paper/broker');
jest.mock('../../src/risk/riskManager');
jest.mock('../../src/core/positionManager');
jest.mock('../../src/core/scheduler');

// Mock Config Manager to prevent validation errors during import
jest.mock('../../src/config', () => ({
    __esModule: true,
    default: {
        isKillSwitchActive: jest.fn().mockReturnValue(false),
        setKillSwitch: jest.fn(),
        getTradingMode: jest.fn().mockReturnValue('PAPER')
    },
    configManager: {
        isKillSwitchActive: jest.fn().mockReturnValue(false),
        setKillSwitch: jest.fn(),
        getTradingMode: jest.fn().mockReturnValue('PAPER')
    }
}));

describe('TradingEngine', () => {
    let engine: TradingEngine;

    // Default Config
    const config: AppConfig = {
        trading: {
            mode: TradingMode.PAPER,
            riskLimits: {
                maxRiskPerTradePercent: 1,
                maxDailyLossPercent: 2,
                positionSizePercent: 10,
                marginMultiplier: 5,
                useMargin: true
            },
            marketStartTime: '09:15',
            marketEndTime: '15:30',
            autoSquareOffTime: '15:20',
            killSwitch: false
        },
        broker: { apiKey: '', clientId: '', password: '', totpSecret: '' },
        telegram: { botToken: '', chatId: '' },
        logLevel: 'info',
        enableAuditLog: false
    };

    beforeEach(() => {
        jest.clearAllMocks();
        // Setup default mocks
        (marginChecker.checkMarginAvailable as jest.Mock).mockResolvedValue({ available: true, margin: 100000, required: 10000 });
        (orderIdempotencyManager.canPlaceOrder as jest.Mock).mockReturnValue(true);
        (orderIdempotencyManager.generateOrderKey as jest.Mock).mockReturnValue('TEST_KEY');

        // Initialize Engine
        engine = new TradingEngine(config);

        // Mock Scheduler to allow signals (market hours = true)
        (engine['scheduler'].isMarketHours as jest.Mock).mockReturnValue(true);
        (engine['scheduler'].isSignalGenerationHours as jest.Mock).mockReturnValue(true);
        (engine['scheduler'].isAfterSquareOffTime as jest.Mock).mockReturnValue(false);

        // Mock Broker LTP
        (engine['broker'].getLTP as jest.Mock).mockResolvedValue(100);
        (engine['broker'].getAccountBalance as jest.Mock).mockResolvedValue(100000);

        // Mock Risk Manager
        (engine['riskManager'].checkOrderRisk as jest.Mock).mockReturnValue({ allowed: true });
        (engine['riskManager'].calculatePositionSize as jest.Mock).mockReturnValue(10);

        // Mock Position Manager
        (engine['positionManager'].getAllPositions as jest.Mock).mockReturnValue([]);
    });

    describe('handleStrategySignal', () => {
        test('should reject signal if margin insufficient', async () => {
            // Setup Insufficient Margin
            (marginChecker.checkMarginAvailable as jest.Mock).mockResolvedValue({
                available: false,
                margin: 5000,
                required: 10000
            });

            await engine['handleStrategySignal']({
                symbol: 'REL',
                action: 'BUY',
                quantity: 100,
                reason: 'Test'
            });

            // Verify Idempotency Marked Failed
            expect(orderIdempotencyManager.markOrderFailed).toHaveBeenCalledWith(
                'TEST_KEY',
                expect.stringContaining('Insufficient margin')
            );

            // Verify Order NOT placed
            expect(engine['broker'].placeOrder).not.toHaveBeenCalled();
        });

        test('should reject signal if risk check fails', async () => {
            // Setup Risk Failure
            (engine['riskManager'].checkOrderRisk as jest.Mock).mockReturnValue({
                allowed: false,
                reason: 'Max positions reached'
            });

            await engine['handleStrategySignal']({
                symbol: 'REL',
                action: 'BUY',
                quantity: 100,
                reason: 'Test'
            });

            expect(orderIdempotencyManager.markOrderFailed).toHaveBeenCalledWith(
                'TEST_KEY',
                'Max positions reached'
            );
            expect(engine['broker'].placeOrder).not.toHaveBeenCalled();
        });

        test('should place order if all checks pass', async () => {
            // Setup Broker Success
            (engine['broker'].placeOrder as jest.Mock).mockResolvedValue({
                orderId: 'ORDER_123',
                status: 'SUBMITTED',
                quantity: 100,
                side: OrderSide.BUY
            });

            // Mock OrderFillMonitor (tricky as it's new-ed inside)
            // We might skip wait verification or mock the constructor via Jest manual mock system if strict.
            // But for simple flow, we verify placeOrder is called.

            // We need to ensure await works. Engine awaits fillMonitor.waitForFill.
            // Since we can't easily mock `new OrderFillMonitor()`, this test might hang or error if not handled.
            // Actually, `TradingEngine` imports `OrderFillMonitor` from services.
            // We can mock the module!

            await engine['handleStrategySignal']({
                symbol: 'REL',
                action: 'BUY',
                quantity: 100,
                reason: 'Test'
            });

            expect(engine['broker'].placeOrder).toHaveBeenCalled();
            expect(orderIdempotencyManager.markOrderCompleted).toHaveBeenCalledWith('TEST_KEY', 'ORDER_123');
        });
    });
});

// We need to mock OrderFillMonitor module too
jest.mock('../../src/services/orderFillMonitor', () => {
    return {
        OrderFillMonitor: jest.fn().mockImplementation(() => {
            return {
                waitForFill: jest.fn().mockResolvedValue({
                    status: 'FILLED',
                    filled: 100,
                    averagePrice: 100
                }) // Return mocked fill result
            };
        })
    };
});
