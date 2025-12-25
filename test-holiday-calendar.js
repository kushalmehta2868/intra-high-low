// Quick test script for holiday calendar
const { holidayCalendar } = require('./dist/services/holidayCalendar');

console.log('=== NSE Holiday Calendar Test ===\n');

// Test 1: Check if Christmas 2025 is a holiday
const christmas2025 = new Date('2025-12-25T10:00:00+05:30');
console.log('1. Is Christmas 2025 (Dec 25) a holiday?', holidayCalendar.isHoliday(christmas2025));
console.log('   Is it a trading day?', holidayCalendar.isTradingDay(christmas2025));

// Test 2: Check if a regular weekday is a trading day
const regularDay = new Date('2025-01-15T10:00:00+05:30');
console.log('\n2. Is Jan 15, 2025 (regular Wednesday) a trading day?', holidayCalendar.isTradingDay(regularDay));

// Test 3: Check if weekend is a trading day
const saturday = new Date('2025-01-18T10:00:00+05:30');
console.log('\n3. Is Jan 18, 2025 (Saturday) a trading day?', holidayCalendar.isTradingDay(saturday));

// Test 4: Get upcoming holidays
console.log('\n4. Next 5 upcoming holidays from today:');
const upcoming = holidayCalendar.getUpcomingHolidays(5);
upcoming.forEach(h => {
  console.log(`   - ${h.date}: ${h.name}${h.isMuhuratTrading ? ' (Muhurat Trading)' : ''}`);
});

// Test 5: Get all 2025 holidays
console.log('\n5. All NSE holidays in 2025:');
const holidays2025 = holidayCalendar.getHolidaysForYear(2025);
console.log(`   Total: ${holidays2025.length} holidays`);
holidays2025.forEach(h => {
  console.log(`   - ${h.date}: ${h.name}`);
});

// Test 6: Check Diwali 2025 (should have Muhurat trading)
const diwali2025 = new Date('2025-10-21T10:00:00+05:30');
console.log('\n6. Is Diwali 2025 (Oct 21) a Muhurat trading day?', holidayCalendar.isMuhuratTradingDay(diwali2025));
console.log('   Is it counted as a trading day?', holidayCalendar.isTradingDay(diwali2025));

console.log('\n=== Test Complete ===');
