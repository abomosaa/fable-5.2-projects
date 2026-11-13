import type { TrackDef } from '../track';

/**
 * Harbor Circuit: a wide, fast asphalt circuit. High grip, long straights,
 * sweeping corners and a forgiving grass run-off that costs speed (and a
 * power-cut penalty if you linger on it).
 */
export const HARBOR: TrackDef = {
  id: 'harbor',
  name: 'Harbor Circuit',
  tagline: 'Wide, fast asphalt with sweeping corners and grass run-off.',
  theme: 'harbor',
  difficulty: 'Easy',
  halfWidth: 7,
  runoff: 5,
  checkpoints: 10,
  defaultLaps: 3,
  surface: {
    name: 'Asphalt',
    grip: 1.25,
    offroadGrip: 0.62,
    offroadDrag: 1,
    wallRestitution: 0.3,
    wallFriction: 0.25,
  },
  points: [
    [0, 0],
    [110, 0],
    [220, 4],
    [305, 42],
    [338, 128],
    [300, 212],
    [212, 240],
    [140, 196],
    [62, 172],
    [-8, 214],
    [-78, 262],
    [-176, 292],
    [-262, 252],
    [-282, 168],
    [-222, 122],
    [-150, 128],
    [-112, 88],
    [-160, 44],
    [-232, 40],
    [-262, -18],
    [-212, -52],
    [-120, -14],
    [-60, 0],
  ],
};
