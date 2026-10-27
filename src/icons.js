/*
 * One icon set, drawn on a 24-unit grid with a 1.75 stroke, so every icon
 * has the same weight. Sized by CSS (.i). Never use text glyphs or emoji
 * for icons: iOS draws some arrows and marks as colour emoji.
 */

const svg = (d) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`;

export const I = {
  letGo: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  cal: svg('<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>'),
  pin: svg('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>'),
  mail: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>'),
  music: svg('<path d="M9 18.5V6l11-2.5v12.5"/><circle cx="6.5" cy="18.5" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>'),
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
  menu: svg('<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>'),
  next: svg('<path d="M9 5l7 7-7 7"/>'),
  prev: svg('<path d="M15 5l-7 7 7 7"/>'),
  down: svg('<path d="M12 5v13M6.5 12.5L12 18l5.5-5.5"/>'),
  edit: svg('<path d="M4.5 19.5l1-4.2L15.8 5a2 2 0 0 1 2.9 0l.3.3a2 2 0 0 1 0 2.9L8.7 18.5z"/><path d="M13.5 7.3l3.2 3.2"/>'),
  trash: svg('<path d="M4.5 7h15M9.5 7V4.8h5V7"/><path d="M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7"/><path d="M10 11v6M14 11v6"/>'),
  keep: svg('<path d="M7 4.5h10v15l-5-3.5-5 3.5z"/>'),
  heart: svg('<path d="M12 19.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 6.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z"/>'),
  heartFill: '<svg class="i fill" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 19.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 6.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z"/></svg>',
  reply: svg('<path d="M20 11.5a7.5 7.5 0 0 1-11 6.6L4.5 19.5l1.3-4.2A7.5 7.5 0 1 1 20 11.5z"/>'),
  user: svg('<circle cx="12" cy="9" r="3.6"/><path d="M5.5 19.5a6.5 6.5 0 0 1 13 0"/>'),
};

/*
 * The Shoebox mark: a box with its lid lifted, things standing inside.
 * Colours come from the page's tokens (--logo-box, --logo-rim, --logo-card),
 * so it follows the theme.
 */
export const LOGO = '<svg class="logo-svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false">'
  + '<rect x="10" y="22" width="9" height="12" rx="1.5" style="fill:var(--logo-card);stroke:var(--logo-rim)" stroke-width="2"/><rect x="21" y="19" width="10" height="15" rx="1.5" style="fill:var(--logo-card);stroke:var(--logo-rim)" stroke-width="2"/><rect x="33" y="21" width="9" height="13" rx="1.5" style="fill:var(--logo-card);stroke:var(--logo-rim)" stroke-width="2"/><path d="M5 31h54v19a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5z" style="fill:var(--logo-box)"/><g class="lid" transform="rotate(-16 6 26)"><rect x="3" y="17" width="58" height="10" rx="3" style="fill:var(--logo-rim)"/></g>' + '</svg>';
