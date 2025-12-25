import { logger } from '../utils/logger';

/**
 * NSE India Market Holiday Calendar
 *
 * Official holidays for NSE (National Stock Exchange) India
 * Source: https://www.nseindia.com/resources/exchange-communication-holidays
 *
 * NOTE: Holidays for years beyond 2026 are estimated based on typical patterns.
 * Update this file when NSE officially announces future year holidays.
 */

interface Holiday {
  date: string; // Format: YYYY-MM-DD
  name: string;
  isMuhuratTrading?: boolean; // Special Diwali trading session
}

export class HolidayCalendar {
  private holidays: Map<string, Holiday[]> = new Map();
  private readonly IST_TIMEZONE = 'Asia/Kolkata';

  constructor() {
    this.initializeHolidays();
  }

  /**
   * Initialize NSE holiday calendar
   * Official data for 2025-2026, estimated for future years
   */
  private initializeHolidays(): void {
    // 2025 - Official NSE Holidays
    this.holidays.set('2025', [
      { date: '2025-02-26', name: 'Mahashivratri' },
      { date: '2025-03-14', name: 'Holi' },
      { date: '2025-03-31', name: 'Eid-ul-Fitr' },
      { date: '2025-04-10', name: 'Mahavir Jayanti' },
      { date: '2025-04-14', name: 'Dr. Baba Saheb Ambedkar Jayanti' },
      { date: '2025-04-18', name: 'Good Friday' },
      { date: '2025-05-01', name: 'Maharashtra Day' },
      { date: '2025-08-15', name: 'Independence Day' },
      { date: '2025-08-27', name: 'Ganesh Chaturthi' },
      { date: '2025-10-02', name: 'Mahatma Gandhi Jayanti' },
      { date: '2025-10-21', name: 'Diwali - Laxmi Pujan', isMuhuratTrading: true },
      { date: '2025-10-22', name: 'Diwali - Balipratipada' },
      { date: '2025-11-05', name: 'Guru Nanak Jayanti' },
      { date: '2025-12-25', name: 'Christmas' }
    ]);

    // 2026 - Official NSE Holidays
    this.holidays.set('2026', [
      { date: '2026-01-26', name: 'Republic Day' },
      { date: '2026-03-03', name: 'Mahashivratri' },
      { date: '2026-03-25', name: 'Holi' },
      { date: '2026-03-30', name: 'Ram Navami' },
      { date: '2026-04-02', name: 'Mahavir Jayanti' },
      { date: '2026-04-03', name: 'Good Friday' },
      { date: '2026-04-06', name: 'Dr. Baba Saheb Ambedkar Jayanti' },
      { date: '2026-05-01', name: 'Maharashtra Day' },
      { date: '2026-08-17', name: 'Ganesh Chaturthi' },
      { date: '2026-10-02', name: 'Mahatma Gandhi Jayanti' },
      { date: '2026-10-08', name: 'Dussehra' },
      { date: '2026-10-27', name: 'Diwali - Laxmi Pujan', isMuhuratTrading: true },
      { date: '2026-10-28', name: 'Diwali - Balipratipada' },
      { date: '2026-11-25', name: 'Guru Nanak Jayanti' },
      { date: '2026-12-25', name: 'Christmas' }
    ]);

    // 2027 - Estimated (to be updated with official NSE announcement)
    this.holidays.set('2027', [
      { date: '2027-01-26', name: 'Republic Day' },
      { date: '2027-02-21', name: 'Mahashivratri (estimated)' },
      { date: '2027-03-15', name: 'Holi (estimated)' },
      { date: '2027-03-25', name: 'Good Friday' },
      { date: '2027-04-02', name: 'Ram Navami (estimated)' },
      { date: '2027-04-14', name: 'Dr. Baba Saheb Ambedkar Jayanti' },
      { date: '2027-04-21', name: 'Mahavir Jayanti (estimated)' },
      { date: '2027-05-01', name: 'Maharashtra Day' },
      { date: '2027-08-15', name: 'Independence Day' },
      { date: '2027-09-06', name: 'Ganesh Chaturthi (estimated)' },
      { date: '2027-10-02', name: 'Mahatma Gandhi Jayanti' },
      { date: '2027-10-17', name: 'Dussehra (estimated)' },
      { date: '2027-11-06', name: 'Diwali - Laxmi Pujan (estimated)', isMuhuratTrading: true },
      { date: '2027-11-07', name: 'Diwali - Balipratipada (estimated)' },
      { date: '2027-11-15', name: 'Guru Nanak Jayanti (estimated)' },
      { date: '2027-12-25', name: 'Christmas' }
    ]);

    // 2027+ holidays will be added here when NSE officially announces them
    // DO NOT add estimated dates - they will be incorrect due to lunar calendar

    const currentYear = new Date().getFullYear();
    const availableYears = Array.from(this.holidays.keys());
    const latestYear = Math.max(...availableYears.map(y => parseInt(y)));

    logger.info('📅 NSE Holiday Calendar initialized', {
      years: availableYears.join(', '),
      totalHolidays: Array.from(this.holidays.values()).reduce((sum, list) => sum + list.length, 0),
      latestYearAvailable: latestYear,
      currentYear: currentYear
    });

    // Warn if we're approaching or past the last available year
    if (currentYear >= latestYear) {
      logger.warn('⚠️ URGENT: Holiday calendar needs update!', {
        currentYear,
        latestAvailableYear: latestYear,
        action: 'Update src/services/holidayCalendar.ts with new NSE holidays',
        source: 'https://www.nseindia.com/resources/exchange-communication-holidays'
      });
    } else if (currentYear === latestYear - 1) {
      logger.warn('⚠️ Holiday calendar will need update soon', {
        currentYear,
        latestAvailableYear: latestYear,
        action: `Update calendar before ${latestYear + 1}`,
        source: 'https://www.nseindia.com/resources/exchange-communication-holidays'
      });
    }
  }

  /**
   * Check if a given date is a market holiday
   * @param date Date to check (defaults to today)
   * @returns true if holiday, false if trading day
   */
  public isHoliday(date: Date = new Date()): boolean {
    // Convert to IST
    const istDate = new Date(date.toLocaleString('en-US', { timeZone: this.IST_TIMEZONE }));
    const year = istDate.getFullYear().toString();
    const dateStr = this.formatDate(istDate);

    const yearHolidays = this.holidays.get(year);
    if (!yearHolidays) {
      logger.error(`❌ CRITICAL: No holiday data for year ${year}!`, {
        action: 'Update src/services/holidayCalendar.ts with NSE holidays',
        source: 'https://www.nseindia.com/resources/exchange-communication-holidays',
        impact: 'Bot may trade on holidays - UPDATE IMMEDIATELY'
      });
      // Fail safe: treat as trading day (conservative approach)
      // Better to miss a holiday than to skip a trading day
      return false;
    }

    const holiday = yearHolidays.find(h => h.date === dateStr);

    if (holiday) {
      logger.debug(`Market holiday detected: ${holiday.name}`, { date: dateStr });
      return true;
    }

    return false;
  }

  /**
   * Check if a given date has Muhurat trading (special Diwali session)
   * @param date Date to check
   * @returns true if Muhurat trading day
   */
  public isMuhuratTradingDay(date: Date = new Date()): boolean {
    const istDate = new Date(date.toLocaleString('en-US', { timeZone: this.IST_TIMEZONE }));
    const year = istDate.getFullYear().toString();
    const dateStr = this.formatDate(istDate);

    const yearHolidays = this.holidays.get(year);
    if (!yearHolidays) return false;

    const holiday = yearHolidays.find(h => h.date === dateStr);
    return holiday?.isMuhuratTrading === true;
  }

  /**
   * Get upcoming holidays
   * @param count Number of upcoming holidays to return
   * @returns Array of upcoming holidays
   */
  public getUpcomingHolidays(count: number = 5): Holiday[] {
    const today = new Date();
    const istToday = new Date(today.toLocaleString('en-US', { timeZone: this.IST_TIMEZONE }));
    const todayStr = this.formatDate(istToday);

    const allHolidays: Holiday[] = [];

    // Collect all holidays from current year and next few years
    for (let year = istToday.getFullYear(); year <= istToday.getFullYear() + 3; year++) {
      const yearHolidays = this.holidays.get(year.toString());
      if (yearHolidays) {
        allHolidays.push(...yearHolidays);
      }
    }

    // Filter future holidays and sort by date
    const upcoming = allHolidays
      .filter(h => h.date >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, count);

    return upcoming;
  }

  /**
   * Get all holidays for a specific year
   * @param year Year to get holidays for
   * @returns Array of holidays for the year
   */
  public getHolidaysForYear(year: number): Holiday[] {
    return this.holidays.get(year.toString()) || [];
  }

  /**
   * Format date to YYYY-MM-DD
   */
  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Check if trading is allowed (not weekend, not holiday)
   * @param date Date to check
   * @returns true if trading is allowed
   */
  public isTradingDay(date: Date = new Date()): boolean {
    const istDate = new Date(date.toLocaleString('en-US', { timeZone: this.IST_TIMEZONE }));
    const day = istDate.getDay();

    // Weekend check (Saturday = 6, Sunday = 0)
    if (day === 0 || day === 6) {
      return false;
    }

    // Holiday check
    if (this.isHoliday(date)) {
      // Exception: Muhurat trading days are trading days (special session)
      return this.isMuhuratTradingDay(date);
    }

    return true;
  }

  /**
   * Get next trading day from a given date
   * @param date Starting date
   * @returns Next trading day
   */
  public getNextTradingDay(date: Date = new Date()): Date {
    let nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);

    while (!this.isTradingDay(nextDay)) {
      nextDay.setDate(nextDay.getDate() + 1);
    }

    return nextDay;
  }

  /**
   * Get calendar statistics
   */
  public getStatistics() {
    const years = Array.from(this.holidays.keys()).map(y => parseInt(y));
    const currentYear = new Date().getFullYear();

    return {
      availableYears: years,
      minYear: Math.min(...years),
      maxYear: Math.max(...years),
      currentYear: currentYear,
      needsUpdate: currentYear >= Math.max(...years),
      totalHolidays: Array.from(this.holidays.values()).reduce((sum, list) => sum + list.length, 0)
    };
  }

  /**
   * Check if calendar data needs update
   * @returns true if calendar should be updated with new year data
   */
  public needsUpdate(): boolean {
    const currentYear = new Date().getFullYear();
    const availableYears = Array.from(this.holidays.keys()).map(y => parseInt(y));
    const latestYear = Math.max(...availableYears);

    return currentYear >= latestYear;
  }

  /**
   * Log update instructions
   * Call this method to get detailed instructions for updating the calendar
   */
  public logUpdateInstructions(): void {
    const currentYear = new Date().getFullYear();
    const stats = this.getStatistics();

    logger.info('📅 NSE Holiday Calendar Update Instructions', {
      currentYear,
      latestYearAvailable: stats.maxYear,
      needsUpdate: stats.needsUpdate
    });

    if (stats.needsUpdate) {
      logger.warn('⚠️ UPDATE REQUIRED - Follow these steps:');
      logger.info('Step 1: Visit NSE official holiday page');
      logger.info('   URL: https://www.nseindia.com/resources/exchange-communication-holidays');
      logger.info('Step 2: Download the latest holiday circular (PDF)');
      logger.info(`Step 3: Open src/services/holidayCalendar.ts`);
      logger.info(`Step 4: Add new year section for ${currentYear + 1} in initializeHolidays() method`);
      logger.info('Step 5: Copy the format from 2025/2026 sections');
      logger.info('Step 6: Fill in official dates from NSE circular');
      logger.info('Step 7: Run npm run build to verify');
      logger.info('Step 8: Test with: node test-holiday-calendar.js');
    } else {
      logger.info(`✅ Calendar is up to date (covers through ${stats.maxYear})`);
    }
  }
}

// Singleton instance
export const holidayCalendar = new HolidayCalendar();
