import { marginChecker } from '../../src/services/marginChecker';
import { IBroker } from '../../src/brokers/base';

// Mock Broker
const mockBroker = {
    getAccountBalance: jest.fn()
} as unknown as IBroker;

describe('MarginChecker', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('should allow trade if sufficient margin', async () => {
        (mockBroker.getAccountBalance as jest.Mock).mockResolvedValue(100000);

        const orderValue = 100000;
        const multiplier = 5;

        const result = await marginChecker.checkMarginAvailable(mockBroker, orderValue, multiplier);
        // Required = 20000. Available = 100000.

        expect(result.available).toBe(true);
        expect(result.shortfall).toBe(0);
    });

    test('should reject trade if insufficient margin', async () => {
        (mockBroker.getAccountBalance as jest.Mock).mockResolvedValue(10000); // 10k cash

        const orderValue = 100000; // 100k value
        const multiplier = 5;
        // Required = 20000. Available = 10000.

        const result = await marginChecker.checkMarginAvailable(mockBroker, orderValue, multiplier);

        expect(result.available).toBe(false);
        expect(result.shortfall).toBe(10000);
    });
});
