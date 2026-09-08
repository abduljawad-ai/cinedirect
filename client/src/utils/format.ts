export { formatBytes, esc, stripHtml } from "../core/parsing";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const month = MONTHS[d.getUTCMonth()] ?? "";
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  return `${month} ${day}, ${year}`;
}

export function formatRelativeTime(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const now = Date.now();
  const diff = Math.max(0, now - date.getTime());

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return "just now";
  if (diff < hour) {
    const mins = Math.floor(diff / minute);
    return mins === 1 ? "1 minute ago" : `${mins} minutes ago`;
  }
  if (diff < day) {
    const hours = Math.floor(diff / hour);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  if (diff < 7 * day) {
    const days = Math.floor(diff / day);
    return days === 1 ? "1 day ago" : `${days} days ago`;
  }
  if (diff < 30 * day) {
    const weeks = Math.floor(diff / (7 * day));
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }
  if (diff < 365 * day) {
    const months = Math.floor(diff / (30 * day));
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }
  const years = Math.floor(diff / (365 * day));
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

export function truncate(str: string, maxLength: number): string {
  if (!str) return "";
  if (str.length <= maxLength) return str;
  const slice = str.slice(0, maxLength - 1).replace(/\s+\S*$/, "");
  return `${slice}…`;
}

export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  delay: number,
): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: Parameters<T>) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  };
  return wrapped as T;
}

export function throttle<T extends (...args: never[]) => void>(
  fn: T,
  limit: number,
): T {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = limit - (now - last);
    if (remaining <= 0) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      last = now;
      fn(...args);
      return;
    }
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...args);
      }, remaining);
    }
  };
  return wrapped as T;
}
