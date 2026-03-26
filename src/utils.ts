import crypto from 'crypto';

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  const hrs = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (min < 1) return 'щойно';
  if (min < 60) return `${min} хв тому`;
  if (hrs < 24) return `${hrs} год тому`;
  if (days === 1) return 'вчора';
  return `${days} дн тому`;
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Returns the next occurrence of HH:MM.
 * If that time has already passed today, returns tomorrow at that time.
 */
export function nextOccurrenceOf(hour: number, minute: number): Date {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setHours(hour, minute);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

export function isTomorrow(date: Date): boolean {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return (
    date.getFullYear() === tomorrow.getFullYear() &&
    date.getMonth() === tomorrow.getMonth() &&
    date.getDate() === tomorrow.getDate()
  );
}

export function token(): string {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Parses a date string in DD.MM or DD.MM.YYYY format.
 * Returns a Date at midnight (local time) or null if invalid.
 */
export function parseDate(input: string): Date | null {
  const match = input.trim().match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/);
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const year = match[3] ? parseInt(match[3], 10) : new Date().getFullYear();

  if (month < 0 || month > 11 || day < 1 || day > 31) return null;

  const date = new Date(year, month, day, 0, 0, 0, 0);
  // Catch invalid dates like 31.02
  if (date.getMonth() !== month || date.getDate() !== day) return null;

  return date;
}

const MONTHS_UK = [
  'січня','лютого','березня','квітня','травня','червня',
  'липня','серпня','вересня','жовтня','листопада','грудня',
];

/**
 * Human-readable schedule label: "сьогодні о 18:30" / "завтра о 18:30" / "25 квітня о 18:30"
 */
export function formatScheduleLabel(date: Date): string {
  const now = new Date();
  const timeStr = formatTime(date);

  if (date.toDateString() === now.toDateString()) return `сьогодні о ${timeStr}`;

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `завтра о ${timeStr}`;

  const yearStr = date.getFullYear() !== now.getFullYear() ? ` ${date.getFullYear()}` : '';
  return `${date.getDate()} ${MONTHS_UK[date.getMonth()]}${yearStr} о ${timeStr}`;
}
