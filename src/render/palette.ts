/** World colours in one place, so the scene reads as one style. */
export const palette = {
  sky: 0xcfdde8,
  skyLight: 0xe3eefc,
  groundLight: 0x5d6b52,
  ground: 0x9fb48c,
  gridMajor: 0x55634a,
  gridMinor: 0x7a8a6c,
  asphalt: 0x3b3f46,
  junction: 0x3e424a,
  sidewalk: 0xc9c6bd,
  marking: 0xf1f1ec,
  island: 0x7fa36a,
  islandKerb: 0xd8d4c8,
  treeLeaves: 0x4f7d45,
  treeTrunk: 0x6b4f37,
  pole: 0x2b2f35,
  signalHead: 0x1d2025,
  lampRed: 0xff3b30,
  lampAmber: 0xffb020,
  lampGreen: 0x32d16f,
  lampOff: 0x2a2d31,
  entry: 0x3d8bfd,
  exit: 0xff8a3d,
  hover: 0x5aa9ff,
  select: 0xffd166,
  danger: 0xff5d5d,
  valid: 0x5aa9ff,
} as const;

/** Distinct colours for colouring vehicles by destination. */
export const destinationColors = [
  0xe6194b, 0x3cb44b, 0xffe119, 0x4363d8, 0xf58231, 0x911eb4, 0x46f0f0, 0xf032e6, 0xbcf60c, 0xfabebe, 0x008080, 0xe6beff,
];
