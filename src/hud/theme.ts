/** HUD look: dark translucent panels, one accent, status colours. */
export const theme = {
  font: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  panel: 'rgba(17, 21, 29, 0.92)',
  panelBorder: 'rgba(255, 255, 255, 0.07)',
  raised: 'rgba(255, 255, 255, 0.045)',
  hover: 'rgba(255, 255, 255, 0.09)',
  press: 'rgba(255, 255, 255, 0.15)',
  track: 'rgba(255, 255, 255, 0.10)',
  text: '#e8edf5',
  dim: '#93a0b4',
  faint: '#5f6a7b',
  accent: '#5aa9ff',
  accentSoft: 'rgba(90, 169, 255, 0.18)',
  accentText: '#08111f',
  good: '#46d39a',
  warn: '#ffb547',
  bad: '#ff5d5d',
  shadow: 'rgba(0, 0, 0, 0.45)',
} as const;

export function font(size: number, weight = 500): string {
  return `${weight} ${size}px ${theme.font}`;
}

/** Level of service colour (A–F). */
export function losColor(grade: string): string {
  switch (grade) {
    case 'A':
      return '#46d39a';
    case 'B':
      return '#8bd65a';
    case 'C':
      return '#d6d24a';
    case 'D':
      return '#ffb547';
    case 'E':
      return '#ff8a4c';
    default:
      return '#ff5d5d';
  }
}
