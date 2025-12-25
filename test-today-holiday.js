// Test if bot will run today
const { holidayCalendar } = require('./dist/services/holidayCalendar');

console.log('=== Testing Today\'s Status ===\n');

const today = new Date();
const istDate = new Date(today.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
const dayName = istDate.toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'Asia/Kolkata' });
const dateStr = istDate.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

console.log(`Current Date (IST): ${dateStr}`);
console.log(`Day: ${dayName}`);
console.log();

const isTradingDay = holidayCalendar.isTradingDay(today);
const isHoliday = holidayCalendar.isHoliday(today);
const dayOfWeek = istDate.getDay();
const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

console.log(`Is Trading Day? ${isTradingDay}`);
console.log(`Is Holiday? ${isHoliday}`);
console.log(`Is Weekend? ${isWeekend}`);
console.log();

if (!isTradingDay) {
  console.log('🚫 BOT WILL NOT START TODAY');
  console.log();

  if (isWeekend) {
    console.log(`Reason: ${dayName} (Weekend)`);
  } else if (isHoliday) {
    const yearHolidays = holidayCalendar.getHolidaysForYear(istDate.getFullYear());
    const todayHoliday = yearHolidays.find(h => {
      const holidayDate = new Date(h.date + 'T00:00:00+05:30');
      return holidayDate.getDate() === istDate.getDate() &&
             holidayDate.getMonth() === istDate.getMonth() &&
             holidayDate.getFullYear() === istDate.getFullYear();
    });
    console.log(`Reason: ${todayHoliday ? todayHoliday.name : 'Market Holiday'}`);
  }

  console.log();
  const nextTradingDay = holidayCalendar.getNextTradingDay(today);
  const nextTradingDayStr = nextTradingDay.toLocaleDateString('en-IN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Kolkata'
  });
  console.log(`📅 Next Trading Day: ${nextTradingDayStr}`);
} else {
  console.log('✅ BOT WILL START TODAY');
  console.log('This is a trading day - normal operations will proceed');
}

console.log('\n=== Test Complete ===');
