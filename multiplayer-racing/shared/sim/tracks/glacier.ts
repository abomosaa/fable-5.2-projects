import type { TrackDef } from '../track';

/**
 * Glacier Pass: a narrow, twisty mountain road on packed snow and ice. Grip is
 * roughly half of asphalt, braking distances are long, the car slides
 * willingly and snow banks sit right at the road edge.
 */
export const GLACIER: TrackDef = {
  id: 'glacier',
  name: 'Glacier Pass',
  tagline: 'Narrow, icy switchbacks between snow banks. Low grip, big slides.',
  theme: 'glacier',
  difficulty: 'Hard',
  halfWidth: 5.5,
  runoff: 1.5,
  checkpoints: 12,
  defaultLaps: 3,
  surface: {
    name: 'Packed ice',
    grip: 0.66,
    offroadGrip: 0.5,
    offroadDrag: 1.6,
    wallRestitution: 0.12,
    wallFriction: 0.45,
  },
  points: [
    [0, 0],
    [70, 0],
    [135, -12],
    [178, -52],
    [170, -108],
    [118, -128],
    [78, -92],
    [34, -66],
    [-10, -96],
    [-24, -150],
    [-78, -178],
    [-134, -150],
    [-140, -92],
    [-100, -58],
    [-112, -14],
    [-164, -6],
    [-204, -44],
    [-250, -18],
    [-246, 38],
    [-196, 62],
    [-140, 44],
    [-92, 12],
    [-46, 0],
  ],
};
