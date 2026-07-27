/**
 * The report figure and its page. `figure.ts` draws the SVG, `page.ts` wraps it
 * in a printable white page, `tokens.ts` holds the shared visual vocabulary.
 */

export type { ChartOptions, Series } from './figure.js';
export { renderReportSvg } from './figure.js';
export { renderReportHtml } from './page.js';
export { TOKEN, vendorOf } from './tokens.js';
