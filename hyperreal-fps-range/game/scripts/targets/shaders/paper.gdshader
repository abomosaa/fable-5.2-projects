shader_type spatial;
// Printed paper target face with persistent bullet holes.
// `field` (tiled Texture2DArray, 4 px/mm): < 0.25 hole (discarded: the cardboard / daylight shows through),
// 0.27-0.39 pale torn fibre rim and lifted tabs, 0.42-0.95 dark grey bullet wipe fading outward, 1.0 untouched.
render_mode cull_back, diffuse_burley, specular_schlick_ggx;

// 8-bit grey, holding LINEAR reflectance (paper 0.93, printed black 0.035) - deliberately no source_color hint
uniform sampler2D artwork : filter_linear_mipmap_anisotropic, repeat_disable;
uniform sampler2D paper_normal : hint_normal, filter_linear_mipmap, repeat_enable;
uniform sampler2DArray field : filter_linear_mipmap, repeat_disable;
uniform vec2 grid = vec2(9.0, 10.0);         // tiles across / down
uniform vec2 canvas_scale = vec2(1.0);       // face size in pixels / (grid * tile size)
uniform vec3 paper_tint : source_color = vec3(0.93, 0.86, 0.70);
uniform vec3 fibre_color : source_color = vec3(0.93, 0.92, 0.88);
uniform vec3 wipe_color : source_color = vec3(0.30, 0.30, 0.31);
uniform float normal_tiles = 3.0;

void fragment() {
	vec2 t = UV * canvas_scale * grid;
	vec2 cell = min(floor(t), grid - 1.0);
	float layer = cell.y * grid.x + cell.x;
	float f = textureGrad(field, vec3(t - cell, layer), dFdx(t), dFdy(t)).r;
	if (f < 0.25) {
		discard;                       // real see-through: whatever is behind the sheet shows
	}
	vec3 ink = texture(artwork, UV).rgb * paper_tint;
	// bullet wipe: lead / lube / powder residue left on the rim, dark grey, fading out by ~4.8 mm from the centre.
	// The steep curve keeps the ring solid at close range and keeps a far-away hole (where the field is averaged
	// over a whole pixel) reading as a dark dot.
	float wipe = clamp((f - 0.41) / 0.54, 0.0, 1.0);
	float clean = pow(wipe, 2.6);
	vec3 col = mix(min(ink, wipe_color), ink, clean);
	// torn rim and folded-up tabs: bare paper fibre, lighter than the printed face - also inside the black
	float fibre = 1.0 - smoothstep(0.385, 0.415, f);
	col = mix(col, fibre_color * (0.82 + 0.18 * smoothstep(0.25, 0.39, f)), fibre);
	ALBEDO = col;
	ROUGHNESS = mix(0.82, 0.95, fibre);
	SPECULAR = 0.3;
	NORMAL_MAP = texture(paper_normal, UV * normal_tiles + vec2(fibre * 0.37)).rgb;
	NORMAL_MAP_DEPTH = 0.35 + fibre * 1.6;
}
