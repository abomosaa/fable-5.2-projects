class_name RangeLayout
## Single source of truth for range dimensions (metres). Godot axes: +Y up, -Z = downrange.
## The firing line is the plane z = 0. Distances to targets are measured from it.

# --- Covered firing bay (acoustic context A) -------------------------------------------
const BAY_X_MIN := -6.2      # inner face of the left (block) wall
const BAY_X_MAX := 2.0       # open right side (posts only) -> walk out to the open pad
const BAY_Z_BACK := 4.6      # inner face of the back wall
const BAY_Z_FRONT := -0.9    # front edge of the concrete slab
const BAY_ROOF_Z_FRONT := -1.8 # roof overhang beyond the firing line
const BAY_ROOF_H_BACK := 2.55  # underside of roof at the back wall
const BAY_ROOF_H_FRONT := 3.05 # underside of roof at the front beam
const BAY_LANE_X := [-4.8, -3.2, -1.6, 0.0]  # lane centre lines (1.6 m pitch)
const BENCH_Z_FRONT := -0.75   # downrange edge of the shooting bench
const BENCH_DEPTH := 0.60
const BENCH_HEIGHT := 0.92
const DIVIDER_X := [-4.0, -2.4, -0.8]  # plywood lane dividers between lanes
const DIVIDER_Z := [-0.9, 0.5]         # z extent of dividers
const DIVIDER_H := [0.95, 2.1]         # y extent (sit on bench line upward)

# --- Open firing position (acoustic context B) -----------------------------------------
const PAD_X_MIN := 4.2
const PAD_X_MAX := 8.6
const PAD_Z_BACK := 3.6
const PAD_Z_FRONT := -0.9
const PAD_LANE_X := [5.6, 7.2]
const PAD_TABLE_CENTER := Vector3(6.4, 0.0, -0.45)  # simple wooden table at the line

# --- Downrange -------------------------------------------------------------------------
const TARGET_LINES := [7.0, 10.0, 15.0, 25.0, 50.0]   # marked distances (signs on the right side)
const BERM_TOE_Z := -53.0      # where the backstop slope starts
const BERM_CREST_Z := -60.0
const BERM_HEIGHT := 6.5
const SIDE_BERM_X_LEFT := -12.5   # crest lines of side berms
const SIDE_BERM_X_RIGHT := 15.0
const SIDE_BERM_HEIGHT := 4.0
const PLAY_BOUNDS := AABB(Vector3(-10.5, -1.0, -52.5), Vector3(23.0, 12.0, 60.0))

# --- Player ------------------------------------------------------------------------------
const SPAWN := Vector3(-1.6, 0.0, 0.55)   # standing at bay lane 3, behind the bench
const EYE_HEIGHT := 1.66

# --- Physics layers (bit numbers, 1-based as in the editor) ------------------------------
const LAYER_WORLD := 1      # static environment
const LAYER_PLAYER := 2
const LAYER_TARGET := 3     # dynamic/hittable targets & props
const LAYER_DEBRIS := 4     # casings, fragments, dropped magazines
## Bullets ray-cast against LAYER_WORLD | LAYER_TARGET.

## Surface tags: every StaticBody3D in the environment carries meta "surface" with one of:
const SURFACES := ["concrete", "gravel", "dirt", "grass", "wood", "plywood", "sheet_metal", "steel", "rubber", "sandbag", "block"]
