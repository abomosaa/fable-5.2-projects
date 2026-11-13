// Biome library: ground cover + scatter layers for each biome, and the default ground-material
// texture assignment per terrain preset. `match` entries are expanded against the asset manifest
// (exact id, or every `<id>__variant`). Per-model `scale` brings scanned assets to the intended
// real-world size (several scanned "trees" are 3-5 m individuals).

import { MAT } from './biomes.js';

const M = (match, weight = 1, scale = 1) => ({ match, weight, scale });

const CONIFERS = [M('fir_sapling_medium', 5.5, 1.6), M('pine_sapling_medium', 2.2, 1.35), M('fir_tree_01__a', 1.1, 1.0), M('fir_tree_01__b', 1.1, 1.15), M('pine_tree_01__b', 0.7, 1.05), M('pine_tree_01__a', 0.5, 0.95), M('fir_tree_01__c', 0.2, 1.0)];
const YOUNG_CONIFERS = [M('fir_sapling_medium', 3, 0.75), M('pine_sapling_medium', 1, 0.6), M('fir_sapling', 2, 1.6), M('pine_sapling_small', 2, 1.6)];
const BROADLEAF = [M('tree_small_02', 3, 2.4), M('jacaranda_tree', 1, 0.75), M('island_tree_01', 1, 2.0), M('island_tree_02', 0.8, 2.2)];
const SHRUBS = [M('shrub_02', 3, 1.0), M('searsia_lucida', 2, 1.0)];
const HERBS = [M('shrub_01', 2, 1.6), M('shrub_03', 2, 1.5), M('shrub_04', 1, 2.0)];
const GRASS = [M('grass_medium_01', 2, 1.7), M('grass_medium_02', 2, 1.5)];
const FLOWERS = [M('dandelion_01', 2, 1.3), M('celandine_01', 1.2, 1.3), M('weed_plant_02', 1, 1.6)];
const FERNS = [M('fern_02', 1, 1.7)];
const BOULDERS = [M('boulder_01', 1.4, 1.2), M('rock_moss_set_01', 1, 0.8), M('rock_moss_set_02', 1.2, 1.0), M('namaqualand_boulder_03', 0.5, 0.8)];
const COBBLES = [M('stone_01', 2, 3.0), M('rock_07', 1.5, 1.8), M('rock_09', 1, 4.5)];
const DEADWOOD = [M('dead_tree_trunk', 1, 1.0), M('dead_tree_trunk_02', 0.6, 1.0), M('tree_stump_01', 1, 1.0), M('tree_stump_02', 1, 1.0), M('dry_branches_medium_01', 2, 1.4)];

function rocksLayer(id, name, models, extra = {}) {
  return { id, name, group: 'rocks', models, spacing: 9, density: 0.3, slope: [0, 0.9, 0.3], scale: [0.6, 1.5], align: 0.5, sink: 0.14, cluster: 0.7, clusterScale: 28, tilt: 0.25, vigorScale: false, ...extra };
}
const grassLayer = (extra = {}) => ({ id: 'grass', name: 'Grass', group: 'ground', models: GRASS, spacing: 0.43, density: 0.9, range: 55, slope: [0, 0.9, 0.2], scale: [0.75, 1.35], cluster: 0.3, clusterScale: 7, align: 0.7, onMaterial: MAT.grass, waterDist: [0.4, 1e9, 0.6], ...extra });
const herbLayer = (extra = {}) => ({ id: 'herbs', name: 'Herbs', group: 'ground', models: HERBS, spacing: 1.6, density: 0.3, range: 26, slope: [0, 0.8, 0.2], scale: [0.8, 1.4], cluster: 0.85, clusterScale: 12, align: 0.5, waterDist: [0.6, 1e9, 1], ...extra });
const fernLayer = (extra = {}) => ({ id: 'ferns', name: 'Ferns', group: 'ground', models: FERNS, spacing: 1.5, density: 0.34, range: 75, slope: [0, 0.8, 0.2], scale: [0.7, 1.4], cluster: 0.85, clusterScale: 9, align: 0.3, waterDist: [0.6, 1e9, 1], ...extra });
const flowerLayer = (extra = {}) => ({ id: 'flowers', name: 'Wildflowers', group: 'ground', models: FLOWERS, spacing: 1.3, density: 0.24, range: 42, slope: [0, 0.6, 0.2], scale: [0.8, 1.3], cluster: 0.9, clusterScale: 11, onMaterial: MAT.grass, waterDist: [0.5, 1e9, 1], ...extra });

export const BIOME_LIBRARY = {
  conifer_forest: {
    id: 'conifer_forest',
    name: 'Conifer forest',
    color: '#2f5d3a',
    auto: { priority: 2, altMax: 2050, slopeMax: 1.05, moistMin: 0.1 },
    ground: { primary: 'forest', secondary: 'grass', secondaryAmount: 0.5, secondaryBias: -0.08 },
    layers: [
      { id: 'trees', name: 'Conifers', group: 'trees', models: CONIFERS, spacing: 4.6, density: 0.78, slope: [0, 0.95, 0.2], scale: [0.72, 1.28], cluster: 0.4, clusterScale: 55, tilt: 0.03, waterDist: [2.5, 1e9, 3] },
      { id: 'saplings', name: 'Young conifers', group: 'understory', models: YOUNG_CONIFERS, spacing: 5.5, density: 0.3, slope: [0, 0.9, 0.2], scale: [0.7, 1.3], cluster: 0.75, clusterScale: 22, waterDist: [1.5, 1e9, 2] },
      { id: 'shrubs', name: 'Understory shrubs', group: 'understory', models: SHRUBS, spacing: 6, density: 0.2, slope: [0, 0.8, 0.2], scale: [0.6, 1.1], cluster: 0.85, clusterScale: 25, waterDist: [1.5, 1e9, 2] },
      { id: 'deadwood', name: 'Dead wood', group: 'deadwood', models: DEADWOOD, spacing: 14, density: 0.34, slope: [0, 0.6, 0.2], scale: [0.8, 1.2], align: 0.9, cluster: 0.3, tilt: 0.1, vigorScale: false, waterDist: [1, 1e9, 1] },
      rocksLayer('rocks', 'Mossy rocks', BOULDERS, { spacing: 12, density: 0.24 }),
      rocksLayer('stones', 'Stones', COBBLES, { spacing: 3.2, density: 0.2, range: 70, scale: [0.6, 1.5], sink: 0.25 }),
      fernLayer(),
      herbLayer({ density: 0.34 }),
      grassLayer({ id: 'grass', name: 'Forest grass', density: 0.6, spacing: 0.6, cluster: 0.6 }),
    ],
  },
  alpine_meadow: {
    id: 'alpine_meadow',
    name: 'Alpine meadow',
    color: '#7da04a',
    auto: { priority: 1, altMax: 2320, slopeMax: 1.2 },
    ground: { primary: 'grass', secondary: 'scree', secondaryAmount: 0.2, secondaryBias: -0.25 },
    layers: [
      { id: 'trees', name: 'Scattered conifers', group: 'trees', models: [M('fir_sapling_medium', 3, 1.2), M('fir_tree_01__b', 1, 0.8)], spacing: 8, density: 0.12, slope: [0, 0.7, 0.2], scale: [0.5, 1.0], cluster: 0.9, clusterScale: 45, altitude: [-1e9, 2150, 80], waterDist: [3, 1e9, 3] },
      rocksLayer('rocks', 'Boulders', BOULDERS, { spacing: 10, density: 0.3 }),
      rocksLayer('stones', 'Stones', COBBLES, { spacing: 3, density: 0.25, range: 70, scale: [0.6, 1.6], sink: 0.25 }),
      { id: 'shrubs', name: 'Shrubs', group: 'understory', models: SHRUBS, spacing: 7, density: 0.16, slope: [0, 0.8, 0.2], scale: [0.5, 1.0], cluster: 0.85, clusterScale: 30, waterDist: [1, 1e9, 2] },
      grassLayer({ name: 'Meadow grass' }),
      herbLayer(),
      flowerLayer(),
    ],
  },
  alpine_rock: {
    id: 'alpine_rock',
    name: 'Alpine rock & scree',
    color: '#8a8a86',
    auto: { priority: 0 },
    ground: { primary: 'scree', secondary: 'grass', secondaryAmount: 0.35, secondaryBias: -0.2 },
    layers: [rocksLayer('rocks', 'Scree boulders', BOULDERS, { spacing: 8, density: 0.4, slope: [0, 1.1, 0.3] }), rocksLayer('stones', 'Stones', COBBLES, { spacing: 2.6, density: 0.35, range: 70, scale: [0.6, 1.8], sink: 0.25 }), grassLayer({ density: 0.5 })],
  },
  riparian: {
    id: 'riparian',
    name: 'River bank',
    color: '#5aa37f',
    auto: { priority: 5, shoreMax: 13, slopeMax: 0.9, altMax: 2100 },
    ground: { primary: 'grass', secondary: 'forest', secondaryAmount: 0.3 },
    layers: [
      rocksLayer('river_boulders', 'River boulders', BOULDERS, { spacing: 4.4, density: 0.34, inChannel: true, onlyChannel: true, maxDepth: 1.4, waterDist: [-1e9, 1e9, 0], obstacle: true, scale: [0.45, 1.35], sink: 0.3, cluster: 0.6, clusterScale: 17, ignoreClearing: true }),
      rocksLayer('bank_stones', 'Bank cobbles', COBBLES, { spacing: 1.6, density: 0.5, onlyChannel: true, inChannel: true, maxDepth: 0.3, scale: [0.6, 2.0], sink: 0.22, cluster: 0.5, clusterScale: 9, range: 90 }),
      { id: 'shrubs', name: 'Bank shrubs', group: 'understory', models: SHRUBS, spacing: 4.2, density: 0.36, slope: [0, 0.7, 0.2], scale: [0.7, 1.3], cluster: 0.7, clusterScale: 18, waterDist: [1.2, 14, 2] },
      { id: 'trees', name: 'Riparian trees', group: 'trees', models: [M('fir_sapling_medium', 3, 1.3), M('pine_sapling_medium', 1, 1.1), M('tree_small_02', 1.5, 2.0)], spacing: 7.5, density: 0.26, slope: [0, 0.6, 0.2], scale: [0.6, 1.05], cluster: 0.6, clusterScale: 30, waterDist: [3.5, 1e9, 3] },
      { id: 'deadwood', name: 'Driftwood', group: 'deadwood', models: [M('dead_tree_trunk', 1), M('dry_branches_medium_01', 2, 1.5)], spacing: 13, density: 0.32, slope: [0, 0.5, 0.2], scale: [0.7, 1.1], align: 1, onlyChannel: true, maxDepth: 0.1, waterDist: [0.2, 6, 1], vigorScale: false, tilt: 0.1 },
      fernLayer({ density: 0.3 }),
      herbLayer({ density: 0.4 }),
      grassLayer({ name: 'Lush bank grass', scale: [0.9, 1.6], spacing: 0.4 }),
      flowerLayer({ density: 0.14 }),
    ],
  },
  mixed_forest: {
    id: 'mixed_forest',
    name: 'Mixed forest',
    color: '#3f6f3a',
    auto: { priority: 2, slopeMax: 0.95, moistMin: 0.16 },
    ground: { primary: 'forest', secondary: 'grass', secondaryAmount: 0.5, secondaryBias: -0.05 },
    layers: [
      { id: 'trees', name: 'Canopy', group: 'trees', models: [...BROADLEAF.map((m) => ({ ...m, weight: m.weight * 1.1 })), ...CONIFERS.map((m) => ({ ...m, weight: m.weight * 0.75 }))], spacing: 5.2, density: 0.74, slope: [0, 0.85, 0.2], scale: [0.75, 1.3], cluster: 0.4, clusterScale: 60, tilt: 0.04, waterDist: [2.2, 1e9, 3] },
      { id: 'saplings', name: 'Understory', group: 'understory', models: [...YOUNG_CONIFERS, ...SHRUBS], spacing: 5.2, density: 0.32, slope: [0, 0.8, 0.2], scale: [0.7, 1.3], cluster: 0.7, clusterScale: 20, waterDist: [1.2, 1e9, 2] },
      { id: 'deadwood', name: 'Dead wood', group: 'deadwood', models: DEADWOOD, spacing: 15, density: 0.32, slope: [0, 0.5, 0.2], scale: [0.8, 1.2], align: 0.9, vigorScale: false, tilt: 0.1, waterDist: [1, 1e9, 1] },
      rocksLayer('rocks', 'Mossy rocks', BOULDERS, { spacing: 14, density: 0.22 }),
      fernLayer(),
      herbLayer({ density: 0.36 }),
      grassLayer({ name: 'Forest grass', density: 0.6, spacing: 0.6, cluster: 0.6 }),
    ],
  },
  meadow: {
    id: 'meadow',
    name: 'Meadow',
    color: '#86a84e',
    auto: { priority: 1, slopeMax: 1.2 },
    ground: { primary: 'grass', secondary: 'forest', secondaryAmount: 0.12, secondaryBias: -0.3 },
    layers: [
      { id: 'trees', name: 'Lone trees', group: 'trees', models: BROADLEAF, spacing: 12, density: 0.12, slope: [0, 0.5, 0.2], scale: [0.8, 1.3], cluster: 0.9, clusterScale: 50, waterDist: [3, 1e9, 3] },
      { id: 'shrubs', name: 'Shrubs', group: 'understory', models: SHRUBS, spacing: 7, density: 0.2, slope: [0, 0.7, 0.2], scale: [0.7, 1.3], cluster: 0.85, clusterScale: 30, waterDist: [1, 1e9, 2] },
      rocksLayer('rocks', 'Field stones', BOULDERS, { spacing: 18, density: 0.18, scale: [0.4, 1.0] }),
      grassLayer({ name: 'Meadow grass', scale: [0.9, 1.6] }),
      herbLayer(),
      flowerLayer({ density: 0.3 }),
    ],
  },
  lakeshore: {
    id: 'lakeshore',
    name: 'Lake shore',
    color: '#9db26a',
    auto: { priority: 5, shoreMax: 9, slopeMax: 0.8 },
    ground: { primary: 'grass', secondary: 'mud', secondaryAmount: 0.2 },
    layers: [
      { id: 'reeds', name: 'Reed beds', group: 'reeds', models: [{ id: 'proc_reed', weight: 3, scale: 1 }, { id: 'proc_cattail', weight: 1, scale: 1 }], spacing: 0.42, density: 0.92, slope: [0, 0.35, 0.1], scale: [0.75, 1.3], cluster: 1.0, clusterScale: 26, maxDepth: 0.75, minDepth: -0.25, waterDist: [0, 1.6, 0.6], tilt: 0.1, vigorScale: false },
      rocksLayer('shore_rocks', 'Shore rocks', BOULDERS, { spacing: 5.5, density: 0.26, maxDepth: 0.8, waterDist: [0, 6, 2], scale: [0.3, 1.0], sink: 0.25, cluster: 0.8, clusterScale: 22 }),
      rocksLayer('shore_stones', 'Shore cobbles', COBBLES, { spacing: 1.5, density: 0.45, maxDepth: 0.4, waterDist: [0, 3, 1], scale: [0.6, 2.0], sink: 0.22, cluster: 0.7, clusterScale: 10, range: 80 }),
      { id: 'shrubs', name: 'Shore shrubs', group: 'understory', models: SHRUBS, spacing: 4.2, density: 0.34, slope: [0, 0.6, 0.2], scale: [0.7, 1.4], cluster: 0.7, clusterScale: 18, waterDist: [1.5, 12, 2] },
      { id: 'trees', name: 'Shoreline trees', group: 'trees', models: [M('island_tree_01', 1.4, 2.0), M('island_tree_02', 1.4, 2.2), M('tree_small_02', 1.6, 2.2), M('fir_sapling_medium', 1, 1.3)], spacing: 8, density: 0.34, slope: [0, 0.6, 0.2], scale: [0.7, 1.2], cluster: 0.5, clusterScale: 35, waterDist: [3.5, 1e9, 2.5] },
      { id: 'deadwood', name: 'Driftwood', group: 'deadwood', models: [M('dead_tree_trunk', 1), M('dry_branches_medium_01', 2, 1.5)], spacing: 16, density: 0.3, slope: [0, 0.4, 0.2], scale: [0.7, 1.1], align: 1, maxDepth: 0.2, waterDist: [0, 4, 1], vigorScale: false, tilt: 0.1 },
      herbLayer({ density: 0.4 }),
      grassLayer({ name: 'Shore grass', scale: [1.0, 1.8], spacing: 0.4 }),
      flowerLayer({ density: 0.16 }),
    ],
  },
  beach: {
    id: 'beach',
    name: 'Beach & foreshore',
    color: '#d8c79a',
    auto: { priority: 6, shoreMax: 42, altMax: 4.2, slopeMax: 0.35, altJitter: 0.02, shoreJitter: 0 },
    ground: { primary: 'sand' },
    layers: [
      { id: 'driftwood', name: 'Driftwood', group: 'deadwood', models: [M('dead_tree_trunk', 1), M('dry_branches_medium_01', 3, 1.5)], spacing: 15, density: 0.25, slope: [0, 0.3, 0.1], scale: [0.6, 1.1], align: 1, altitude: [1.2, 4, 0.5], vigorScale: false, tilt: 0.1, waterDist: [3, 1e9, 2] },
      rocksLayer('beach_rocks', 'Beach stones', [M('boulder_01', 1.5, 0.8), M('namaqualand_boulder_03', 1, 0.6), M('rock_moss_set_02', 0.6, 0.9)], { spacing: 9, density: 0.16, maxDepth: 1.5, waterDist: [-1e9, 1e9, 0], scale: [0.4, 1.0], sink: 0.3, cluster: 0.95, clusterScale: 34 }),
      rocksLayer('pebbles', 'Pebbles', COBBLES, { spacing: 1.4, density: 0.3, maxDepth: 0.3, waterDist: [-1e9, 1e9, 0], scale: [0.4, 1.4], sink: 0.3, cluster: 0.95, clusterScale: 16, range: 60 }),
      // dune grass colonises the dry back beach in clumps, above the reach of the swash
      grassLayer({ id: 'dunegrass', name: 'Dune grass', spacing: 0.6, density: 0.55, range: 70, scale: [0.9, 1.7], cluster: 0.92, clusterScale: 10, onMaterial: undefined, altitude: [2.0, 9, 0.5], waterDist: [16, 1e9, 6], slope: [0, 0.5, 0.2] }),
    ],
  },
  rocky_shore: {
    id: 'rocky_shore',
    name: 'Rocky shore',
    color: '#6f6a62',
    auto: { priority: 5, shoreMax: 24, altMax: 14, altJitter: 0.05 },
    ground: { primary: 'scree' },
    layers: [
      rocksLayer('coast_rocks', 'Coastal rocks', [M('coast_rocks_05', 2, 1.0), M('rock_face_02', 0.7, 0.8), M('boulder_01', 2, 1.6), M('namaqualand_boulder_03', 1.2, 1.2), M('rock_moss_set_02', 0.8, 1.3)], { spacing: 6, density: 0.42, maxDepth: 2.5, waterDist: [-1e9, 14, 4], slope: [0, 1.6, 0.4], scale: [0.6, 1.6], sink: 0.3, cluster: 0.6, clusterScale: 24 }),
      rocksLayer('stones', 'Cobbles', COBBLES, { spacing: 1.6, density: 0.4, range: 70, maxDepth: 0.5, waterDist: [-1e9, 16, 3], scale: [0.6, 2.2], sink: 0.25 }),
    ],
  },
  coastal_scrub: {
    id: 'coastal_scrub',
    name: 'Coastal grass & scrub',
    color: '#8f9f58',
    auto: { priority: 2, altMax: 75, slopeMax: 1.3 },
    ground: { primary: 'grass', secondary: 'scree', secondaryAmount: 0.12, secondaryBias: -0.3 },
    layers: [
      { id: 'shrubs', name: 'Scrub', group: 'understory', models: SHRUBS, spacing: 4, density: 0.44, slope: [0, 0.9, 0.2], scale: [0.6, 1.3], cluster: 0.8, clusterScale: 26, waterDist: [4, 1e9, 4] },
      { id: 'trees', name: 'Wind-shaped trees', group: 'trees', models: [M('island_tree_02', 1.5, 2.0), M('island_tree_01', 1, 1.8), M('tree_small_02', 1, 1.8)], spacing: 11, density: 0.16, slope: [0, 0.6, 0.2], scale: [0.6, 1.0], cluster: 0.9, clusterScale: 60, altitude: [8, 1e9, 6], waterDist: [25, 1e9, 10] },
      rocksLayer('rocks', 'Outcrop stones', BOULDERS, { spacing: 13, density: 0.25 }),
      grassLayer({ name: 'Coastal grass', waterDist: [1, 1e9, 1] }),
      herbLayer(),
      flowerLayer({ density: 0.2 }),
    ],
  },
  coastal_forest: {
    id: 'coastal_forest',
    name: 'Coastal forest',
    color: '#3c6a3b',
    auto: { priority: 1, slopeMax: 0.95, moistMin: 0.18 },
    ground: { primary: 'forest', secondary: 'grass', secondaryAmount: 0.5 },
    layers: [
      { id: 'trees', name: 'Canopy', group: 'trees', models: [...CONIFERS, ...BROADLEAF.map((m) => ({ ...m, weight: m.weight * 0.6 }))], spacing: 5.2, density: 0.7, slope: [0, 0.85, 0.2], scale: [0.7, 1.2], cluster: 0.45, clusterScale: 60, waterDist: [20, 1e9, 10] },
      { id: 'saplings', name: 'Understory', group: 'understory', models: [...YOUNG_CONIFERS, ...SHRUBS], spacing: 5.8, density: 0.3, slope: [0, 0.8, 0.2], scale: [0.7, 1.3], cluster: 0.7, clusterScale: 20 },
      rocksLayer('rocks', 'Rocks', BOULDERS, { spacing: 14, density: 0.22 }),
      fernLayer(),
      herbLayer(),
      grassLayer({ name: 'Forest grass', density: 0.6, spacing: 0.6, cluster: 0.6 }),
    ],
  },
};

export const PRESET_BIOMES = {
  alpine: ['riparian', 'conifer_forest', 'alpine_meadow', 'alpine_rock'],
  lake: ['lakeshore', 'riparian', 'mixed_forest', 'meadow'],
  coast: ['beach', 'rocky_shore', 'coastal_scrub', 'coastal_forest'],
  hills: ['riparian', 'lakeshore', 'mixed_forest', 'meadow'],
};

// Default texture set per ground layer: preferred manifest id, fallback role, tint.
const L = (texture, role, tint) => ({ texture, role, tint });
const BASE_MATS = {
  grass: L('forrest_ground_01', 'grass', [0.42, 0.56, 0.36]),
  forest: L('forest_leaves_02', 'forest_floor', [0.25, 0.33, 0.48]),
  scree: L('gray_rocks', 'scree', [0.9, 0.9, 0.9]),
  sand: L('dense_sand', 'sand', [1, 1, 1]),
  pebbles: L('ganges_river_pebbles', 'pebbles', [0.9, 0.9, 0.9]),
  mud: L('brown_mud_03', 'mud', [0.85, 0.85, 0.85]),
  snow: L('snow_02', 'snow', [2.0, 2.0, 2.02]),
  path: L('rocky_trail_02', 'trail_dirt', [0.72, 0.68, 0.62]),
  rock: L('mossy_rock', 'rock_cliff', [0.92, 0.92, 0.92]),
};
export const PRESET_MATERIALS = {
  alpine: BASE_MATS,
  lake: { ...BASE_MATS, path: L('gravel_floor_02', 'gravel_road', [0.8, 0.78, 0.74]) },
  coast: { ...BASE_MATS, rock: L('lichen_rock', 'rock_coast', [1.15, 1.12, 1.08]), sand: L('dense_sand', 'sand', [1.0, 0.98, 0.94]), scree: L('rocks_ground_01', 'scree', [0.85, 0.84, 0.82]), grass: L('forrest_ground_01', 'grass', [0.46, 0.56, 0.36]) },
  hills: { ...BASE_MATS, path: L('gravel_floor_02', 'gravel_road', [0.8, 0.78, 0.74]) },
};
