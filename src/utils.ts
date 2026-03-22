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

/** Returns next occurrence of 09:00 (today if before 9am, otherwise tomorrow) */
export function nextTomorrow0900(): Date {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setHours(9, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

export function token(): string {
  return crypto.randomBytes(4).toString('hex');
}
