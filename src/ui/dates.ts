import { localDateKey } from '../domain';

/** Format the written local time in KIF without inventing a timezone. */
export function writtenDate(value: string) {
  const key = localDateKey(value);
  if (!key)
    return { key: '', day: '日時不明', short: '日時不明', time: '', full: value || '日時不明' };
  const [date, clock] = key.split(' ');
  const [year, month, day] = date.split('-');
  const time = /[ T]\d{1,2}:/.test(value.trim()) ? clock.slice(0, 5) : '';
  return {
    key,
    day: `${year}年${Number(month)}月${Number(day)}日`,
    short: `${Number(month)}/${Number(day)}`,
    time,
    full: `${year}年${Number(month)}月${Number(day)}日${time ? ` ${time}` : ''}`,
  };
}
