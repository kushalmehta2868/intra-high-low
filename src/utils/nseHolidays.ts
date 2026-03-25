/**
 * NSE Trading Holiday Calendar
 * Source: NSE India official holiday list
 * Update this list each year when NSE publishes the new holiday schedule.
 */

export const NSE_HOLIDAYS: string[] = [
  // --- 2025 ---
  '2025-02-26',
  '2025-03-14',
  '2025-03-31',
  '2025-04-10',
  '2025-04-14',
  '2025-04-18',
  '2025-05-01',
  '2025-08-15',
  '2025-08-27',
  '2025-10-02',
  '2025-10-21',
  '2025-10-22',
  '2025-11-05',
  '2025-12-25',

  // --- 2026 ---
  '2026-01-26',
  '2026-03-03',
  '2026-03-26',
  '2026-03-31',
  '2026-04-03',
  '2026-04-14',
  '2026-05-01',
  '2026-05-28',
  '2026-06-26',
  '2026-09-14',
  '2026-10-02',
  '2026-10-20',
  '2026-11-10',
  '2026-11-24',
  '2026-12-25'
];


/**
 * Returns the IST date string YYYY-MM-DD for a given Date object.
 */
function toISTDateString(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // en-CA gives YYYY-MM-DD
}

/**
 * Returns true if the given date is an NSE trading holiday.
 */
export function isNSEHoliday(date: Date): boolean {
  const dateStr = toISTDateString(date);
  return NSE_HOLIDAYS.includes(dateStr);
}

/**
 * Returns the holiday name/reason for a given date, or null if not a holiday.
 * Useful for logging a friendly message.
 */
export function getNSEHolidayName(date: Date): string | null {
  const dateStr = toISTDateString(date);
  const names: Record<string, string> = {
    "2025-02-26": "Maha Shivaratri",
    "2025-03-14": "Holi",
    "2025-03-31": "Id-Ul-Fitr (Eid)",
    "2025-04-10": "Shri Mahavir Jayanti",
    "2025-04-14": "Dr. Baba Saheb Ambedkar Jayanti",
    "2025-04-18": "Good Friday",
    "2025-05-01": "Maharashtra Day",
    "2025-08-15": "Independence Day",
    "2025-08-27": "Ganesh Chaturthi",
    "2025-10-02": "Gandhi Jayanti",
    "2025-10-21": "Diwali – Laxmi Pujan",
    "2025-10-22": "Diwali – Balipratipada",
    "2025-11-05": "Guru Nanak Jayanti",
    "2025-12-25": "Christmas",
    "2026-01-26": "Republic Day",
    "2026-03-03": "Holi",
    "2026-03-26": "Ram Navami",
    "2026-03-31": "Shri Mahavir Jayanti",
    "2026-04-03": "Good Friday",
    "2026-04-14": "Dr. Baba Saheb Ambedkar Jayanti",
    "2026-05-01": "Maharashtra Day",
    "2026-05-28": "Bakri Id (Eid-Ul-Adha)",
    "2026-06-26": "Muharram",
    "2026-09-14": "Ganesh Chaturthi",
    "2026-10-02": "Gandhi Jayanti",
    "2026-10-20": "Dussehra",
    "2026-11-10": "Diwali – Balipratipada",
    "2026-11-24": "Guru Nanak Jayanti",
    "2026-12-25": "Christmas"
  };
  return names[dateStr] ?? null;
}
