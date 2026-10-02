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
  highlightInk: '#0B714E',
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
 * Series colours: vendor brand colours first (OpenAI, Anthropic, Gemini, then
 * further OpenAI shades and OpenRouter), then a spare black with no vendor claim
 * and the neutral charcoal role. A vendor's first series takes its vendor colour;
 * later series from the same vendor index into this list by sorted position.
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

/**
 * The sequential ramp for a magnitude encoding — a heatmap cell — lightest to
 * darkest. Derived from the same ordered green ramp `TOKEN_CLASSES` uses, with
 * the system's own `accent-soft` as the lightest step, so a change to the ramp
 * carries here instead of a second set of greens drifting away from the first.
 */
export const SEQUENTIAL_RAMP = [
  TOKEN.accentSoft,
  ...[...TOKEN_CLASSES].reverse().map((klass) => klass.colour),
] as const;

export type VendorId =
  | 'openai'
  | 'claude'
  | 'claudecode'
  | 'anthropic'
  | 'openrouter'
  | 'antigravity'
  | 'gemini'
  | 'googlecloud'
  | 'pi'
  | 'local'
  | 'other';

export function vendorColour(vendor: VendorId): string {
  switch (vendor) {
    case 'anthropic':
    case 'claude':
    case 'claudecode':
      return '#D97757';
    case 'openai':
      return '#19C37D';
    case 'gemini':
    case 'googlecloud':
    case 'antigravity':
      return '#3186FF';
    case 'openrouter':
      return '#8CA800'; // Darkened #C8FF00 for contrast on white
    case 'pi':
    case 'local':
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
 * platforms serve those. For the same reason a bare `google` (an OpenRouter
 * author prefix, say) is neutral: it does not say whether Gemini the product or
 * Google Cloud ran the request, and only `vertex`/`gcp`/`google cloud` does.
 * `anthropic` is the API platform; `claude` alone is ccusage's id for Claude
 * Code; any other `claude…` name is the model.
 */
export function vendorOf(name: string): VendorId {
  const key = name.toLowerCase();
  if (/^(pi|pi[-\s]agent)$/.test(key)) return 'pi';
  if (/^claude$|claude[-\s]code/.test(key)) return 'claudecode';
  if (/(^|[/\s[])claude/.test(key)) return 'claude';
  if (/(^|[/\s[])anthropic/.test(key)) return 'anthropic';
  if (/(^|[/\s[])(openai|gpt-|codex|o[134]-)/.test(key)) return 'openai';
  if (/(^|[/\s[])antigravity/.test(key)) return 'antigravity';
  if (/(^|[/\s[])(vertex|gcp|google[-\s]cloud)/.test(key)) return 'googlecloud';
  if (/(^|[/\s[])gemini/.test(key)) return 'gemini';
  if (/openrouter|router/.test(key)) return 'openrouter';
  if (/ccusage|local/.test(key)) return 'local';
  return 'other';
}

/**
 * The vendors' own marks, inlined so the page stays self-contained: the
 * monochrome icons of LobeHub's MIT-licensed set (`@lobehub/icons-static-svg`
 * 1.95.1), paths copied verbatim on a 24-unit grid with even-odd fill. Source and
 * licence are recorded in `brand/vendor-marks/`. They are drawn in the series
 * colour rather than the vendor's own, so the palette stays the report's.
 */
const VENDOR_PATHS: Record<Exclude<VendorId, 'local' | 'other'>, readonly string[]> = {
  openai: [
    'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z',
  ],
  claude: [
    'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z',
  ],
  claudecode: [
    'M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z',
  ],
  anthropic: [
    'M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z',
  ],
  openrouter: [
    'M18.654 3.87a5.087 5.087 0 110 10.174L23.7 19.09c.64.641.187 1.737-.72 1.737H8.48a8.479 8.479 0 010-16.958h10.175zM8.479 7.26a5.087 5.087 0 100 10.176 5.087 5.087 0 000-10.175z',
  ],
  antigravity: [
    'M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z',
  ],
  gemini: [
    'M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z',
  ],
  googlecloud: [
    'M4.914 5.18c3.32-3.762 9.095-4.247 12.91-1.13l.362.312.252.232A9.4 9.4 0 0121.02 8.93 6.778 6.778 0 0124 14.597c-.028 3.744-3.087 6.726-6.83 6.697H6.739a6.746 6.746 0 01-3.869-1.222l-.224-.162-.302-.247a6.778 6.778 0 01.54-10.673l-.004.001a9.644 9.644 0 012.034-3.812zm10.345 2.11c-2.143-1.734-5.282-1.46-7.138.578l-.026.025a6.77 6.77 0 014.045 2.523l-3.023 3.023a2.606 2.606 0 10-2.379 3.682h10.43c1.44 0 2.607-1.137 2.607-2.576a2.607 2.607 0 00-2.606-2.607v-.52a5.205 5.205 0 00-1.685-3.933l-.225-.195z',
  ],
  pi: ['M1 1h16.5v11H12v5.5H6.5V23H1V1zm5.5 5.5V12H12V6.5H6.5z', 'M17.5 12H23v11h-5.5V12z'],
};

/**
 * A vendor's mark at `size` px with its top-left at (`x`, `y`). Two sources have
 * no vendor and keep drawn marks: local agent usage a terminal prompt, and a
 * name that identifies nobody a neutral ring.
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
    case 'local':
      // A terminal prompt: this source is a program on this machine.
      return `<rect x="${round(x + 0.75)}" y="${round(y + s * 0.12)}" width="${round(s - 1.5)}" height="${round(s * 0.76)}" rx="2" ${stroke}/><path d="M${x + s * 0.3} ${y + s * 0.38}L${x + s * 0.48} ${cy}L${x + s * 0.3} ${y + s * 0.62}" ${stroke}/>`;
    case 'other':
      // Neutral: a ring. Used whenever the name does not identify a vendor.
      return `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(half * 0.8)}" ${stroke}/>`;
    default:
      return `<g data-mark="${vendor}" transform="translate(${round(x)}, ${round(y)}) scale(${s / 24})" fill="${colour}" fill-rule="evenodd">${VENDOR_PATHS[vendor].map((d) => `<path d="${d}"/>`).join('')}</g>`;
  }
}

/** Brand spellings for the leading word of a model id; anything else is capitalised. */
const MODEL_FAMILIES: Record<string, string> = {
  deepseek: 'DeepSeek',
  glm: 'GLM',
  gpt: 'GPT',
  minimax: 'MiniMax',
};

/**
 * A readable label for a model id — `claude-opus-4-8` → `Opus 4.8`,
 * `deepseek/deepseek-v4-flash-0731` → `DeepSeek v4 flash`. Display only: the
 * route prefix and snapshot date are dropped, so two ids can share a label, and
 * every place that shows one keeps the full id alongside (a tooltip, the JSON).
 * An agent tag such as `[pi] ` is kept, since it says who ran the model.
 */
export function displayModel(id: string): string {
  const tag = /^\[[^\]]+\]\s*/.exec(id)?.[0] ?? '';
  const name = id
    .slice(tag.length)
    .replace(/^.*\//, '')
    // A snapshot date: -20251001, -2024-08-06, or a four-digit -0731.
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$/, '');

  // Claude ids name the family between the prefix and the version, in either
  // order (`claude-opus-4-8`, the older `claude-3-5-sonnet`).
  const modern = /^claude-([a-z]+)-(\d+)(?:[-.](\d+))?$/.exec(name);
  const legacy = /^claude-(\d+)(?:[-.](\d+))?-([a-z]+)$/.exec(name);
  const [family, major, minor] = modern
    ? [modern[1], modern[2], modern[3]]
    : legacy
      ? [legacy[3], legacy[1], legacy[2]]
      : [];
  if (family && major) {
    return `${tag}${capitalise(family)} ${major}${minor ? `.${minor}` : ''}`;
  }

  const [first = '', ...rest] = name.split('-');
  const lead = MODEL_FAMILIES[first] ?? capitalise(first);
  return name ? `${tag}${[lead, ...rest].join(' ')}` : id;
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
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
