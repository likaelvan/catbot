// Hand-drawn SVG faces for each persona. Add a new key here when you add a persona in personas.py.
window.PERSONA_ICONS = {
  // Chidi: black cat, half-lidded amber eyes, totally unimpressed.
  chidi: `<svg viewBox="0 0 64 64" aria-hidden="true">
    <g style="stroke:var(--muted);stroke-width:1.2;stroke-opacity:.45">
      <path d="M9 30 L13 5 L29 18 Z" fill="#1C1A21"/>
      <path d="M55 30 L51 5 L35 18 Z" fill="#1C1A21"/>
      <ellipse cx="32" cy="37" rx="24" ry="21" fill="#1C1A21"/>
    </g>
    <path d="M14 24 L15.5 11 L24 18.5 Z" fill="#3B3644"/>
    <path d="M50 24 L48.5 11 L40 18.5 Z" fill="#3B3644"/>
    <ellipse cx="22.5" cy="35" rx="6" ry="4.6" fill="#F0B53C"/>
    <ellipse cx="41.5" cy="35" rx="6" ry="4.6" fill="#F0B53C"/>
    <ellipse cx="22.5" cy="36" rx="1.3" ry="3.4" fill="#0B0A0E"/>
    <ellipse cx="41.5" cy="36" rx="1.3" ry="3.4" fill="#0B0A0E"/>
    <path d="M16 30 h13 v5 q-6.5 -1.6 -13 0 Z" fill="#1C1A21"/>
    <path d="M35 30 h13 v5 q-6.5 -1.6 -13 0 Z" fill="#1C1A21"/>
    <path d="M16.5 35 q6 -1.5 12 0 M35.5 35 q6 -1.5 12 0" stroke="#0B0A0E" stroke-width="1.4" fill="none" stroke-linecap="round"/>
    <path d="M30 43 L34 43 L32 45.3 Z" fill="#5A5363"/>
    <path d="M32 45.3 v1.2 M28.5 47.5 h7" stroke="#5A5363" stroke-width="1.3" fill="none" stroke-linecap="round"/>
    <path d="M6 41 L19 43 M7 46 L19 45.5 M58 41 L45 43 M57 46 L45 45.5" stroke="#6E6880" stroke-width="1" stroke-linecap="round" opacity=".8"/>
  </svg>`,

  // Jianyu: orange tabby, big sparkly eyes, blush, tongue out, ready for snacks.
  jianyu: `<svg viewBox="0 0 64 64" aria-hidden="true">
    <path d="M9 30 L12 6 L29 19 Z" fill="#EF8A2E"/>
    <path d="M55 30 L52 6 L35 19 Z" fill="#EF8A2E"/>
    <path d="M14 24 L15 12 L24 19 Z" fill="#FFC6A3"/>
    <path d="M50 24 L49 12 L40 19 Z" fill="#FFC6A3"/>
    <ellipse cx="32" cy="37" rx="24" ry="21" fill="#F59B42"/>
    <path d="M32 17 v7 M25.5 18.5 l2 5.5 M38.5 18.5 l-2 5.5" stroke="#C95F17" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M8.5 35 h6 M9 40.5 h5 M55.5 35 h-6 M55 40.5 h-5" stroke="#C95F17" stroke-width="2.4" stroke-linecap="round"/>
    <ellipse cx="32" cy="45" rx="9" ry="6" fill="#FFE6CF"/>
    <circle cx="22.5" cy="34.5" r="6" fill="#2B1A10"/>
    <circle cx="41.5" cy="34.5" r="6" fill="#2B1A10"/>
    <circle cx="24.8" cy="32.2" r="2.1" fill="#FFF"/>
    <circle cx="43.8" cy="32.2" r="2.1" fill="#FFF"/>
    <circle cx="20.6" cy="37" r="1" fill="#FFF"/>
    <circle cx="39.6" cy="37" r="1" fill="#FFF"/>
    <ellipse cx="15.5" cy="44" rx="4" ry="2.4" fill="#FF7F98" opacity=".55"/>
    <ellipse cx="48.5" cy="44" rx="4" ry="2.4" fill="#FF7F98" opacity=".55"/>
    <path d="M30 41.5 L34 41.5 L32 44 Z" fill="#E5637A"/>
    <path d="M27.5 45.5 q2.2 2.6 4.5 0 q2.3 2.6 4.5 0" stroke="#8A4524" stroke-width="1.4" fill="none" stroke-linecap="round"/>
    <path d="M30.6 47.2 q1.4 4.2 2.8 0 Z" fill="#FF7A93"/>
  </svg>`,

  // Fallback for personas without their own icon.
  _default: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="34" r="22" fill="currentColor" opacity=".25"/></svg>`,
};

window.PAW_ICON = `<svg class="paw" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <ellipse cx="6" cy="10" rx="2.2" ry="2.8"/><ellipse cx="10" cy="6" rx="2.2" ry="2.8"/>
  <ellipse cx="14" cy="6" rx="2.2" ry="2.8"/><ellipse cx="18" cy="10" rx="2.2" ry="2.8"/>
  <path d="M12 11c-3.5 0-6.5 4.2-6.5 6.7 0 1.8 1.4 2.8 3.2 2.8 1.4 0 2.2-.7 3.3-.7s1.9.7 3.3.7c1.8 0 3.2-1 3.2-2.8 0-2.5-3-6.7-6.5-6.7z"/>
</svg>`;
