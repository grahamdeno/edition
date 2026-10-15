/*
 * One icon set, drawn on a 24-unit grid with a 1.75 stroke, so every icon
 * has the same weight. Sized by CSS (.i). Never use text glyphs or emoji
 * for icons: iOS draws some arrows and marks as colour emoji.
 */

const svg = (d) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`;

export const I = {
  letGo: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  later: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  done: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  read: svg('<path d="M3.5 5.5h6A2.5 2.5 0 0 1 12 8v11a2 2 0 0 0-2-2H3.5z"/><path d="M20.5 5.5h-6A2.5 2.5 0 0 0 12 8v11a2 2 0 0 1 2-2h6.5z"/>'),
  open: svg('<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5L11 13"/><path d="M18 14v5.5H4.5V6H10"/>'),
  close: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  settings: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  edition: svg('<rect x="4.5" y="4" width="15" height="16" rx="1.5"/><path d="M8 8.5h8M8 12h8M8 15.5h5"/>'),
  inbox: svg('<path d="M4 13.5L6.5 5h11l2.5 8.5V19H4z"/><path d="M4 13.5h4.5l1 2h5l1-2H20"/>'),
  library: svg('<path d="M5 4.5v15M9.5 4.5v15"/><path d="M14 5.2l4.6 14"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>'),
  paste: svg('<rect x="5.5" y="4.5" width="13" height="16" rx="1.5"/><path d="M9 4.5V3.5h6v1M9 10h6M9 13.5h6M9 17h3"/>'),
  attach: svg('<path d="M19.5 11.5l-7.8 7.8a4.8 4.8 0 0 1-6.8-6.8l8.3-8.3a3.2 3.2 0 0 1 4.5 4.5l-8.3 8.3a1.6 1.6 0 0 1-2.3-2.3l7.6-7.6"/>'),
  requeue: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>'),
  arrow: svg('<path d="M5 12h13M13 7l5 5-5 5"/>'),
  play: svg('<path d="M8 5.5v13l10.5-6.5z"/>'),
};
