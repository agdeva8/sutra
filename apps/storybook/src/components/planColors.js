/**
 * Per-goal colour palettes. Each goal gets one hue; the plan LEVELS use
 * SHADES of that hue (lightest = the goal, darker = tasks), so a glance
 * tells you which goal a row belongs to AND how granular it is.
 *
 * All shades are kept light so dark ink (#1F2937) stays readable on them.
 */
export const PLAN_INK = '#1F2937';

export const GOAL_PALETTES = [
  { name: 'blue',   shades: ['#E0F2FE', '#BAE6FD', '#93C5FD', '#7DD3FC', '#60A5FA'], strong: '#2563EB' },
  { name: 'orange', shades: ['#FFEDD5', '#FED7AA', '#FDBA74', '#FB923C', '#F97316'], strong: '#EA580C' },
  { name: 'green',  shades: ['#DCFCE7', '#BBF7D0', '#A7F3D0', '#86EFAC', '#6EE7B7'], strong: '#16A34A' },
  { name: 'violet', shades: ['#F3E8FF', '#E9D5FF', '#D8B4FE', '#C4B5FD', '#A78BFA'], strong: '#7C3AED' },
];

export const LEVEL_SHADE = { year: 0, quarter: 1, month: 2, week: 3, day: 4, block: 4 };

export function paletteFor(index) {
  const i = ((index || 0) % GOAL_PALETTES.length + GOAL_PALETTES.length) % GOAL_PALETTES.length;
  return GOAL_PALETTES[i];
}

export function shadeFor(palette, level) {
  const p = palette || GOAL_PALETTES[0];
  const i = LEVEL_SHADE[level] === undefined ? 3 : LEVEL_SHADE[level];
  return p.shades[i];
}
