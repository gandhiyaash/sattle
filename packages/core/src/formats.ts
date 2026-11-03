/**
 * Number and date formats, made once each and kept.
 *
 * Making an Intl.NumberFormat or DateTimeFormat costs about fifty times what
 * using one does, and toLocaleDateString makes one on every call. A group's
 * screen shows hundreds of amounts and dates: made fresh for each, they were a
 * third of the time it took to draw, and two thirds of the history's. What
 * they print is the same either way.
 */

const numbers = new Map<string, Intl.NumberFormat>();
const dates = new Map<string, Intl.DateTimeFormat>();

export function numberFormat(locale: string | undefined, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${locale ?? ''} ${JSON.stringify(options)}`;
  let format = numbers.get(key);
  if (!format) numbers.set(key, (format = new Intl.NumberFormat(locale, options)));
  return format;
}

/** What `date.toLocaleString(locale, options)` would say, and its Date and Time variants, from a kept format. */
export function dateFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormat {
  const key = `${locale ?? ''} ${JSON.stringify(options)}`;
  let format = dates.get(key);
  if (!format) dates.set(key, (format = new Intl.DateTimeFormat(locale, options)));
  return format;
}
