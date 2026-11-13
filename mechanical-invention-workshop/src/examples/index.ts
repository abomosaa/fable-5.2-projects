import type { Project } from '../core/model/types';
import { buildFourBar } from './fourbar';
import { buildGearReduction } from './gears';
import { buildCamFollower } from './cam';
import { buildSliderCrank } from './slidercrank';
import { buildWalker } from './walker';

export interface ExampleDef { id: string; file: string; title: string; blurb: string; build: () => Project }

export const EXAMPLES: ExampleDef[] = [
  { id: 'fourbar', file: 'fourbar.json', title: 'Four-bar linkage', blurb: 'Crank-rocker with coupler-point trace and two deliberately invalid variants.', build: buildFourBar },
  { id: 'gears', file: 'gear-reduction.json', title: 'Two-stage gear reduction', blurb: '12 : 1 spur-gear train with a loaded output and a torque-limited motor.', build: buildGearReduction },
  { id: 'cam', file: 'cam-follower.json', title: 'Cam and spring follower', blurb: 'Editable cam program, real contact, follower float at high speed.', build: buildCamFollower },
  { id: 'slidercrank', file: 'slider-crank.json', title: 'Belt-driven slider-crank', blurb: 'Belt ratio and stroke propagate through the assembly.', build: buildSliderCrank },
  { id: 'walker', file: 'walker.json', title: 'Walking linkage robot', blurb: 'Six Jansen legs, free body, floor contact with friction.', build: buildWalker },
];
