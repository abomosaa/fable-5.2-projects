// Curated asset list for the bundled library (public/assets). Edit this, then run
//   node tools/assets/fetch-assets.mjs --pin
// to resolve new entries against the Poly Haven API and pin them (URL + bytes + sha256) in sources.lock.json.
//
// Every entry is a Poly Haven asset id (https://polyhaven.com/a/<id>, CC0-1.0) unless `provider: 'ambientcg'` is given
// (https://ambientcg.com/view?id=<assetId>, CC0-1.0) - used for exactly one lush meadow grass, which Poly Haven lacks.

/**
 * Tileable PBR texture sets -> public/assets/textures/<id>/{diff,nor,arm,disp}.jpg
 * `role` is what the terrain / structure code asks for; the first entry of a role is the recommended default,
 * the following ones are alternates for the asset browser.
 */
export const TEXTURES = [
  // --- terrain
  { id: 'grass_004', role: 'grass', provider: 'ambientcg', assetId: 'Grass004' }, // lush short meadow grass
  { id: 'forrest_ground_01', role: 'grass' },
  { id: 'aerial_grass_rock', role: 'grass' }, // 15 m tile: alpine turf with rock showing through (macro variation)
  { id: 'forest_leaves_04', role: 'forest_floor' }, // needle / twig litter
  { id: 'forest_leaves_02', role: 'forest_floor' }, // moss + leaf litter
  { id: 'marble_rock_01', role: 'rock_cliff' }, // pale grey fractured limestone
  { id: 'mossy_rock', role: 'rock_cliff' },
  { id: 'rock_boulder_dry', role: 'rock_cliff' },
  { id: 'dark_rock', role: 'rock_coast' },
  { id: 'lichen_rock', role: 'rock_coast' },
  { id: 'gray_rocks', role: 'scree' },
  { id: 'rocks_ground_01', role: 'scree' },
  { id: 'dense_sand', role: 'sand' },
  { id: 'aerial_beach_01', role: 'sand' }, // 30 m tile: wind/wave ripples
  { id: 'damp_beach_sand', role: 'sand' }, // wet sand at the waterline
  { id: 'ganges_river_pebbles', role: 'pebbles' },
  { id: 'brown_mud_03', role: 'mud' },
  { id: 'dirt', role: 'mud' },
  { id: 'snow_02', role: 'snow' },
  { id: 'snow_field_aerial', role: 'snow' }, // 80 m tile: wind-packed snow field
  // --- paths
  { id: 'rocky_trail_02', role: 'trail_dirt' },
  { id: 'gravel_floor_02', role: 'gravel_road' },
  { id: 'asphalt_01', role: 'asphalt' },
  // --- structures (procedural cabins)
  { id: 'weathered_planks', role: 'wood_planks' },
  { id: 'weathered_plank_siding', role: 'wood_planks' },
  { id: 'wood_trunk_wall', role: 'wood_logs' },
  { id: 'roof_slates_02', role: 'roof' },
  { id: 'grey_roof_tiles_02', role: 'roof' },
  { id: 'corrugated_iron', role: 'roof' },
  { id: 'stone_wall', role: 'stone_wall' },
  { id: 'green_rough_planks', role: 'wood_door' },
];

/**
 * Models -> public/assets/models/<id>[__<variant>]/lod{0,1[,2]}.glb
 *
 *  profile   LOD budgets + processing strategy (lib/model.mjs PROFILES)
 *  split     'nodes'  : every scene root node is its own variant (<id>__a, <id>__b, ...; natural-sorted node names)
 *  spatial   true     : one mesh holding several objects side by side -> split by ground-plane clusters
 *  only      indices (into the variant list) to keep
 *  nodes     regular expression: only scene root nodes whose name matches are used
 *  out       output id (default: the source id) - lets two entries build different models from one source asset
 *  cards     per LOD: force (true) / forbid (false) baked cluster cards instead of the automatic choice
 *  cardShade albedo multiplier for baked cards (needle foliage: a flat card is lit more evenly than thousands of
 *            randomly turned needles, 0.8 brings it back in line with the source geometry)
 *  hero      allow 2048 px textures on lod0
 *  tags      free-form hints copied into the manifest
 */
export const MODELS = [
  // --- conifers (every scene root node of a Poly Haven tree asset is one individual)
  { id: 'fir_tree_01', category: 'tree_conifer', profile: 'tree', split: 'nodes', cards: [true, true, true], cardShade: 0.8, budgets: [36000, 9000, 2000] },
  { id: 'pine_tree_01', category: 'tree_conifer', profile: 'tree', split: 'nodes', cards: [true, true, true], cardShade: 0.8, budgets: [36000, 9000, 2000] },
  { id: 'fir_sapling_medium', category: 'tree_conifer', profile: 'tree', split: 'nodes', cards: [true, true, true], cardShade: 0.8, budgets: [30000, 8000, 2000], tags: ['young'] },
  { id: 'pine_sapling_medium', category: 'tree_conifer', profile: 'tree', split: 'nodes', cards: [true, true, true], cardShade: 0.8, budgets: [30000, 8000, 2000], tags: ['young'] },
  { id: 'fir_sapling', category: 'tree_conifer', profile: 'sapling', split: 'nodes', cards: [true, true], cardShade: 0.8, tags: ['sapling'] },
  { id: 'pine_sapling_small', category: 'tree_conifer', profile: 'sapling', split: 'nodes', cards: [true, true], cardShade: 0.8, tags: ['sapling'] },
  // --- broadleaf
  { id: 'island_tree_01', category: 'tree_broadleaf', profile: 'tree', split: 'nodes' },
  { id: 'island_tree_02', category: 'tree_broadleaf', profile: 'tree', split: 'nodes' },
  { id: 'island_tree_03', category: 'tree_broadleaf', profile: 'tree', split: 'nodes' },
  { id: 'tree_small_02', category: 'tree_broadleaf', profile: 'tree', split: 'nodes' },
  { id: 'jacaranda_tree', category: 'tree_broadleaf', profile: 'tree', split: 'nodes' },
  // --- shrubs (`only` = indices into the variant list)
  { id: 'shrub_01', category: 'shrub', profile: 'shrub', spatial: true, only: [0, 1, 3, 5, 7] }, // one mesh holding a row of ten plants
  { id: 'shrub_02', category: 'shrub', profile: 'shrub', split: 'nodes' },
  { id: 'shrub_03', category: 'shrub', profile: 'shrub', split: 'nodes' },
  { id: 'shrub_04', category: 'shrub', profile: 'shrub', spatial: true },
  { id: 'searsia_lucida', category: 'shrub', profile: 'bush', split: 'nodes', only: [0, 2, 4, 6] }, // real bushes (0.8 - 2.3 m); natural-sorted nodes a..g
  // --- ground cover
  { id: 'fern_02', category: 'groundcover', profile: 'ground', split: 'nodes' },
  { id: 'nettle_plant', category: 'groundcover', profile: 'ground', split: 'nodes', only: [0, 3, 4, 5], cards: [false, true], cardSize: [[0.25, 0.04, 0.3], [0.25, 0.03, 0.3]] }, // few large welded sprigs: culling would leave 2-3 giant leaves
  { id: 'dandelion_01', category: 'groundcover', profile: 'ground', split: 'nodes' },
  { id: 'celandine_01', category: 'groundcover', profile: 'ground', split: 'nodes' },
  { id: 'weed_plant_02', category: 'groundcover', profile: 'ground', split: 'nodes', only: [0, 1, 2] },
  { id: 'grass_medium_01', category: 'grass', profile: 'ground', split: 'nodes', only: [0, 2, 3, 5, 6, 8, 10] }, // large_a, large_c, mid_a, mid_c, small_a, tall_a, tall_c
  { id: 'grass_medium_02', category: 'grass', profile: 'ground', split: 'nodes' },
  { id: 'grass_bermuda_01', category: 'grass', profile: 'ground', split: 'nodes', only: [9, 10, 11, 12] }, // the four "seedling" tufts; the rest are single blades
  // --- rocks / boulders
  { id: 'boulder_01', category: 'rock', profile: 'rock' },
  { id: 'rock_07', category: 'rock', profile: 'rock' },
  { id: 'rock_09', category: 'rock', profile: 'rock' },
  { id: 'stone_01', category: 'rock', profile: 'rock' },
  { id: 'rock_moss_set_01', category: 'rock', profile: 'rock', split: 'nodes' },
  { id: 'rock_moss_set_02', category: 'rock', profile: 'rock', split: 'nodes' },
  { id: 'namaqualand_boulder_03', category: 'rock', profile: 'rock' },
  { id: 'rock_face_01', category: 'rock', profile: 'rock', hero: true, tags: ['cliff'] },
  { id: 'rock_face_02', category: 'rock', profile: 'rock', hero: true, tags: ['cliff'] },
  { id: 'coast_rocks_01', category: 'rock', profile: 'rock', tags: ['coast', 'outcrop'] },
  { id: 'coast_rocks_03', category: 'rock', profile: 'rock', tags: ['coast', 'outcrop'] },
  { id: 'coast_rocks_05', category: 'rock', profile: 'rock', tags: ['coast'] },
  { id: 'coast_land_rocks_02', category: 'rock', profile: 'rock', tags: ['coast', 'outcrop'] },
  { id: 'sand_rocks_small_01', category: 'rock', profile: 'rock', tags: ['coast'] },
  // --- dead wood
  { id: 'dead_tree_trunk', category: 'deadwood', profile: 'deadwood' },
  { id: 'dead_tree_trunk_02', category: 'deadwood', profile: 'deadwood' },
  { id: 'tree_stump_01', category: 'deadwood', profile: 'deadwood' },
  { id: 'tree_stump_02', category: 'deadwood', profile: 'deadwood' },
  { id: 'root_cluster_01', category: 'deadwood', profile: 'deadwood' },
  { id: 'dry_branches_medium_01', category: 'deadwood', profile: 'deadwood_small', split: 'nodes' },
  // --- structures / props (floating objects, settlement dressing)
  { id: 'modular_wooden_pier', category: 'structure', profile: 'prop', nodes: 'section_0[123]$', tags: ['pier'] }, // three deck sections in a row (8.7 m jetty)
  { id: 'modular_wooden_pier', out: 'modular_wooden_pier_kit', category: 'structure', profile: 'prop', split: 'nodes', tags: ['pier', 'modular'] }, // every module on its own
  { id: 'stone_fire_pit', category: 'prop', profile: 'prop' },
  { id: 'wooden_picnic_table', category: 'prop', profile: 'prop' },
  { id: 'painted_wooden_bench', category: 'prop', profile: 'prop' },
  { id: 'ocean_buoy', category: 'prop', profile: 'prop', tags: ['floating'] },
  { id: 'lateral_sea_marker', category: 'prop', profile: 'prop', tags: ['floating'] },
  { id: 'rubber_duck_toy', category: 'prop', profile: 'prop', tags: ['floating'] },
  { id: 'lifebuoy', category: 'prop', profile: 'prop', tags: ['floating'] },
  { id: 'wine_barrel_01', category: 'prop', profile: 'prop', tags: ['floating'], budgets: [10000, 4500] }, // staves are separate solids: fewer triangles shred them
  { id: 'wooden_crate_01', category: 'prop', profile: 'prop', tags: ['floating'] },
  { id: 'wooden_crate_02', category: 'prop', profile: 'prop', tags: ['floating'] },
  { id: 'wooden_bucket_01', category: 'prop', profile: 'prop', tags: ['floating'] },
];
