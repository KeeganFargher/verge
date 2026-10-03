/**
 * Draw order of the flat layers lying on the ground, as polygon offsets. They sit only
 * centimetres apart, which depth precision can't separate when zoomed out; the offsets can.
 */
const ORDER = { map: 1, asphalt: 2, marking: 4, bar: 5, overlay: 7 } as const;

export function layer(name: keyof typeof ORDER): { polygonOffset: true; polygonOffsetFactor: number; polygonOffsetUnits: number } {
  const k = ORDER[name];
  return { polygonOffset: true, polygonOffsetFactor: -k, polygonOffsetUnits: -k * 2 };
}
