'use strict';

const PERIOD_LABELS = Object.freeze({
  quarter_current: 'Quarter Atual', quarter_last: 'Quarter Passado',
  current_week: 'Semana Atual', last_week: 'Semana Passada',
  current_month: 'Mês Corrente', last_month: 'Mês Passado', all_time: 'Todo Período',
});
function dateOnly(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = type => parts.find(p => p.type === type).value;
  return new Date(`${value('year')}-${value('month')}-${value('day')}T00:00:00Z`);
}
const iso = date => date.toISOString().slice(0, 10);
const shift = (date, days) => new Date(date.getTime() + days * 86400000);
const monthStart = (date, offset = 0) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
function resolvePeriod(period, now = new Date(), timezone = 'America/Sao_Paulo') {
  if (!Object.hasOwn(PERIOD_LABELS, period)) throw Object.assign(new Error('Período inválido.'), { status: 400 });
  if (period === 'all_time') return { key: period, label: PERIOD_LABELS[period], start: null, endExclusive: null, comparison: null, timezone };
  const today = dateOnly(now, timezone);
  const tomorrow = shift(today, 1);
  const monday = shift(today, -((today.getUTCDay() + 6) % 7));
  const quarter = monthStart(today, -(today.getUTCMonth() % 3));
  let start, end, previousStart, previousEnd;
  switch (period) {
    case 'current_week': start = monday; end = tomorrow; previousStart = shift(start, -7); previousEnd = shift(end, -7); break;
    case 'last_week': start = shift(monday, -7); end = monday; previousStart = shift(start, -7); previousEnd = start; break;
    case 'current_month': start = monthStart(today); end = tomorrow; previousStart = monthStart(today, -1); previousEnd = new Date(Math.min(shift(previousStart, (end - start) / 86400000).getTime(), start.getTime())); break;
    case 'last_month': start = monthStart(today, -1); end = monthStart(today); previousStart = monthStart(today, -2); previousEnd = start; break;
    case 'quarter_current': start = quarter; end = tomorrow; previousStart = monthStart(quarter, -3); previousEnd = new Date(Math.min(shift(previousStart, (end - start) / 86400000).getTime(), start.getTime())); break;
    case 'quarter_last': start = monthStart(quarter, -3); end = quarter; previousStart = monthStart(quarter, -6); previousEnd = start; break;
  }
  return { key: period, label: PERIOD_LABELS[period], start: iso(start), endExclusive: iso(end), end: iso(shift(end, -1)), comparison: { start: iso(previousStart), endExclusive: iso(previousEnd), end: iso(shift(previousEnd, -1)), basis: ['current_week', 'current_month', 'quarter_current'].includes(period) ? 'mesma quantidade de dias no período anterior, limitada ao seu fim' : 'período anterior completo' }, timezone };
}
module.exports = { PERIOD_LABELS, resolvePeriod };
