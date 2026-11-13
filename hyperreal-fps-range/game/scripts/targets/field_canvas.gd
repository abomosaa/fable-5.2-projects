extends RefCounted
## Persistent "damage field" painted by bullet hits and shown by a shader.
##
## One 8-bit channel, 1.0 = untouched. A hit multiplies a small pre-made stamp into the field at exactly the hit
## position (Image.blend_rect of an LA8 stamp with L = 0, A = 1 - stamp: dst *= stamp), so overlapping hits merge.
## The shader turns field bands into appearance (hole / torn fibre / bullet wipe; lead / bare steel / smudged
## paint), thresholding the bilinearly filtered field, which keeps edges crisp at any zoom.
##
## The field is cut into tiles stored as layers of a Texture2DArray: a hit re-uploads only the 1-4 small tiles
## it touches (about 0.15 ms for a paper hole), never the whole face. CPU masters exist only for touched tiles.

var tile_px := 256
var cols := 1
var rows := 1
var size_px := Vector2i.ZERO
var texture: Texture2DArray
var _tiles := {}              # layer -> Image (LA8, no mipmaps)
var _dirty_layers := {}       # layers that differ from pristine on the GPU
var _pristine: Image
var uploads := 0

## isolated = true: every tile is an independent surface (stamps never spill into neighbours), e.g. the two
## faces of a steel plate.
var isolated := false

func setup(p_size_px: Vector2i, p_tile_px: int, p_isolated := false) -> void:
	tile_px = p_tile_px
	isolated = p_isolated
	size_px = p_size_px
	cols = int(ceil(float(p_size_px.x) / tile_px))
	rows = int(ceil(float(p_size_px.y) / tile_px))
	_pristine = Image.create(tile_px, tile_px, false, Image.FORMAT_L8)
	_pristine.fill(Color(1, 1, 1, 1))
	_pristine.generate_mipmaps()
	var imgs: Array[Image] = []
	for i in cols * rows:
		imgs.append(_pristine)
	texture = Texture2DArray.new()
	texture.create_from_images(imgs)

func layer_count() -> int:
	return cols * rows

func touched_tiles() -> int:
	return _tiles.size()

func _master(layer: int) -> Image:
	var t: Image = _tiles.get(layer)
	if t == null:
		t = Image.create(tile_px, tile_px, false, Image.FORMAT_LA8)
		t.fill(Color(1, 1, 1, 1))
		_tiles[layer] = t
	return t

func _upload(layer: int) -> void:
	var up: Image = (_tiles[layer] as Image).duplicate()
	up.convert(Image.FORMAT_L8)
	up.generate_mipmaps()
	texture.update_layer(up, layer)
	_dirty_layers[layer] = true
	uploads += 1

## stamp centred at `center_px` (pixels from the top-left of the whole canvas)
func stamp(img: Image, center_px: Vector2) -> void:
	var w := img.get_width()
	var h := img.get_height()
	var x0 := int(round(center_px.x - w * 0.5))
	var y0 := int(round(center_px.y - h * 0.5))
	var tx0 := clampi(int(floor(float(x0) / tile_px)), 0, cols - 1)
	var tx1 := clampi(int(floor(float(x0 + w - 1) / tile_px)), 0, cols - 1)
	var ty0 := clampi(int(floor(float(y0) / tile_px)), 0, rows - 1)
	var ty1 := clampi(int(floor(float(y0 + h - 1) / tile_px)), 0, rows - 1)
	var src := Rect2i(0, 0, w, h)
	for ty in range(ty0, ty1 + 1):
		for tx in range(tx0, tx1 + 1):
			var layer := ty * cols + tx
			_master(layer).blend_rect(img, src, Vector2i(x0 - tx * tile_px, y0 - ty * tile_px))
			_upload(layer)

## stamp into one tile only (isolated canvases); center in that tile's pixels
func stamp_layer(layer: int, img: Image, center_px: Vector2) -> void:
	var w := img.get_width()
	var h := img.get_height()
	_master(layer).blend_rect(img, Rect2i(0, 0, w, h), Vector2i(int(round(center_px.x - w * 0.5)), int(round(center_px.y - h * 0.5))))
	_upload(layer)

func clear() -> void:
	for layer in _dirty_layers:
		texture.update_layer(_pristine, layer)
	_dirty_layers.clear()
	_tiles.clear()

## field value at a canvas pixel (tests)
func value_at(px: Vector2i) -> float:
	var tx := clampi(px.x / tile_px, 0, cols - 1)
	var ty := clampi(px.y / tile_px, 0, rows - 1)
	var t: Image = _tiles.get(ty * cols + tx)
	if t == null:
		return 1.0
	return t.get_pixel(px.x - tx * tile_px, px.y - ty * tile_px).r

## stamps from an LA8 strip of square cells, each also rotated by 90/180/270 degrees and mirrored
static func load_stamps(tex: Texture2D, cell_px: int, out_px := 0, variants := true) -> Array[Image]:
	var out: Array[Image] = []
	var strip := tex.get_image()
	if strip.is_compressed():
		strip.decompress()
	strip.convert(Image.FORMAT_LA8)
	for i in strip.get_width() / cell_px:
		var base := strip.get_region(Rect2i(i * cell_px, 0, cell_px, cell_px))
		if out_px > 0 and out_px != cell_px:
			base.resize(out_px, out_px, Image.INTERPOLATE_LANCZOS if out_px < cell_px else Image.INTERPOLATE_BILINEAR)
		out.append(base)
		if not variants:
			continue
		var r := base
		for k in 3:
			r = r.duplicate()
			r.rotate_90(CLOCKWISE)
			out.append(r)
		var f: Image = base.duplicate()
		f.flip_x()
		out.append(f)
		var f2: Image = f.duplicate()
		f2.rotate_90(CLOCKWISE)
		out.append(f2)
	return out
