/**
 * The report's visual vocabulary: design tokens, series colours and vendor marks.
 *
 * Values are taken from the Soilytix design system (`colors_and_type.css`) rather
 * than invented here, and derived treatments (note fills, risk fills) come from
 * the system's own `accent-soft` and `warn` rather than standalone hexes, so a
 * change to the system carries through instead of drifting.
 */

/** Surfaces and ink. A report is a **white** surface; bone is for slides and app UI. */
export const TOKEN = {
  surface: '#FFFFFF',
  ink: '#29332E', // Obsidian
  body: '#233A2E',
  muted: '#6C7E72',
  subtle: '#93A89B',
  rule: '#E4E7DC',
  grid: '#E8EBE0',
  /** Lime ink — titles and key rules on a light surface. */
  eyebrow: '#4A7A0F',
  /** Mint — the one primary highlight. */
  highlight: '#1AB172',
  /** Deep Mint — Mint at text sizes. */
  highlightInk: '#118B61',
  /** Mint accent-soft: the note/invariant tint everything soft derives from. */
  accentSoft: '#E3EFE0',
  accentSoftInk: '#0B5E49',
  cream: '#F4F5EE',
  /** Warn — every risk treatment derives from this. */
  warn: '#EE7931',
  warnSoft: '#FFF1E7',
  warnSoftInk: '#8A4A16',
  font: "Inter, 'Helvetica Neue', Arial, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
} as const;

/**
 * Series colours: Mint first — the largest series carries the single Mint
 * highlight — then the categorical accents (level 350) and the neutral charcoal
 * role, ordered so adjacent series stay apart. Azure is deliberately absent: the
 * current system has no blue.
 */
export const SERIES_COLOURS = [
  '#19C37D', // OpenAI GPT
  '#D97757', // Anthropic Claude
  '#3186FF', // Google Gemini
  '#AB68FF', // OpenAI GPT-4
  '#F9C322', // OpenAI O1
  '#C8FF00', // OpenRouter
  '#000000', // black (no vendor claim; a spare categorical slot)
  '#4A4A44', // charcoal (neutral role)
] as const;

/**
 * Token classes are *ordered*, not categorical — uncached input, output, cache
 * write, cache read — so they take the system's sequential green ramp instead of
 * the categorical accents.
 */
export const TOKEN_CLASSES = [
  { key: 'input', label: 'input', colour: '#3A5D20' },
  { key: 'output', label: 'output', colour: '#5E8A2A' },
  { key: 'cacheCreation', label: 'cache write', colour: '#86B446' },
  { key: 'cacheRead', label: 'cache read', colour: '#CFE3A3' },
] as const;

export type TokenClassKey = (typeof TOKEN_CLASSES)[number]['key'];

export type VendorId = 'anthropic' | 'openai' | 'google' | 'route' | 'local' | 'other';

export function vendorColour(vendor: VendorId): string {
  switch (vendor) {
    case 'anthropic':
      return '#D97757';
    case 'openai':
      return '#19C37D';
    case 'google':
      return '#3186FF';
    case 'route':
      return '#8CA800'; // Darkened #C8FF00 for contrast on white
    case 'local':
      return '#4A4A44';
    case 'other':
      return '#4A4A44';
  }
}

/**
 * Which mark to draw beside a series name.
 *
 * Matching is deliberately conservative: only names that identify a vendor
 * unambiguously get its mark, and anything else gets the neutral one. An icon is
 * decoration, but a *wrong* icon is a claim about who served the request, so an
 * open-weight model name (llama, qwen, mistral) never picks a vendor — several
 * platforms serve those.
 */
export function vendorOf(name: string): VendorId {
  const key = name.toLowerCase();
  if (/(^|[/\s[])(anthropic|claude)/.test(key)) return 'anthropic';
  if (/(^|[/\s[])(openai|gpt-|codex|o[134]-)/.test(key)) return 'openai';
  if (/(^|[/\s[])(google|gemini|vertex)/.test(key)) return 'google';
  if (/openrouter|router/.test(key)) return 'route';
  if (/ccusage|local/.test(key)) return 'local';
  return 'other';
}

/**
 * The marks themselves: LobeHub brand icons, one per vendor family.
 * They are shape cues that survive at 12px and give every
 * series a second, non-colour identifier.
 */
export function vendorMark(
  vendor: VendorId,
  x: number,
  y: number,
  size: number,
  colour: string,
): string {
  const s = size;
  const half = s / 2;
  const cx = x + half;
  const cy = y + half;
  const stroke = `fill="none" stroke="${colour}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"`;

  switch (vendor) {
    case 'anthropic':
      return `<g transform="translate(${round(x)}, ${round(y)}) scale(${s / 24})"><path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z" fill="${colour}"/></g>`;
    case 'openai':
      return `<g transform="translate(${round(x)}, ${round(y)}) scale(${s / 24})"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" fill="${colour}"/></g>`;
    case 'google':
      return `<g transform="translate(${round(x)}, ${round(y)}) scale(${s / 24})">
        <path d="M23 12.245c0-.905-.075-1.565-.236-2.25h-10.54v4.083h6.186c-.124 1.014-.797 2.542-2.294 3.569l-.021.136 3.332 2.53.23.022C21.779 18.417 23 15.593 23 12.245z" fill="${colour}"/>
        <path d="M12.225 23c3.03 0 5.574-.978 7.433-2.665l-3.542-2.688c-.948.648-2.22 1.1-3.891 1.1a6.745 6.745 0 01-6.386-4.572l-.132.011-3.465 2.628-.045.124C4.043 20.531 7.835 23 12.225 23z" fill="${colour}"/>
        <path d="M5.84 14.175A6.65 6.65 0 015.463 12c0-.758.138-1.491.361-2.175l-.006-.147-3.508-2.67-.115.054A10.831 10.831 0 001 12c0 1.772.436 3.447 1.197 4.938l3.642-2.763z" fill="${colour}"/>
        <path d="M12.225 5.253c2.108 0 3.529.892 4.34 1.638l3.167-3.031C17.787 2.088 15.255 1 12.225 1 7.834 1 4.043 3.469 2.197 7.062l3.63 2.763a6.77 6.77 0 016.398-4.572z" fill="${colour}"/>
      </g>`;
    case 'route':
      return `<g transform="translate(${round(x)}, ${round(y)}) scale(${s / 24})"><path d="M18.654 3.87a5.087 5.087 0 110 10.174L23.7 19.09c.64.641.187 1.737-.72 1.737H8.48a8.479 8.479 0 010-16.958h10.175zM8.479 7.26a5.087 5.087 0 100 10.176 5.087 5.087 0 000-10.175z" fill="${colour}"/></g>`;
    case 'local':
      // A terminal prompt: this source is a program on this machine.
      return `<rect x="${round(x + 0.75)}" y="${round(y + s * 0.12)}" width="${round(s - 1.5)}" height="${round(s * 0.76)}" rx="2" ${stroke}/><path d="M${x + s * 0.3} ${y + s * 0.38}L${x + s * 0.48} ${cy}L${x + s * 0.3} ${y + s * 0.62}" ${stroke}/>`;
    case 'other':
      // Neutral: a ring. Used whenever the name does not identify a vendor.
      return `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(half * 0.8)}" ${stroke}/>`;
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
