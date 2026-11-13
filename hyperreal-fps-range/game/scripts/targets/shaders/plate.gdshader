shader_type spatial;
// White-painted AR500 gong face with persistent lead splashes.
// `field` layer per face: 1.0 fresh paint, 0.99-0.62 paint greyed by lead dust, < 0.45 paint gone (dark bare
// steel - the lowest band, so overlapping hits can only darken toward it), a tent around 0.375 = faint lead smear.
render_mode cull_back, diffuse_burley, specular_schlick_ggx;

uniform sampler2D paint_albedo : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D paint_normal : hint_normal, filter_linear_mipmap, repeat_enable;
uniform sampler2D steel_albedo : source_color, filter_linear_mipmap, repeat_enable;
uniform sampler2D steel_normal : hint_normal, filter_linear_mipmap, repeat_enable;
uniform sampler2DArray field : filter_linear_mipmap, repeat_disable;
uniform float layer = 0.0;
uniform vec3 paint_tint : source_color = vec3(0.90, 0.90, 0.88);
uniform vec3 lead_color : source_color = vec3(0.52, 0.53, 0.55);
uniform vec3 smudge_color : source_color = vec3(0.45, 0.45, 0.47);

void fragment() {
	float f = texture(field, vec3(UV, layer)).r;
	vec3 paint = texture(paint_albedo, UV * 1.5).rgb * paint_tint;
	// bare AR500 under fresh paint is dark grey mill scale, not rust: keep only the texture's luminance variation
	float sl = dot(texture(steel_albedo, UV * 2.0).rgb, vec3(0.5, 0.35, 0.15));
	vec3 steel = vec3(0.115, 0.112, 0.11) * (0.7 + 3.0 * sl);
	float smudge = 1.0 - smoothstep(0.62, 0.99, f);           // lead dust greying the paint
	float bare = 1.0 - smoothstep(0.45, 0.60, f);             // paint gone
	float lead = clamp(1.0 - abs(f - 0.375) / 0.07, 0.0, 1.0);  // faint smear in the middle of a hit
	vec3 col = mix(paint, smudge_color, smudge * 0.55);
	col = mix(col, steel, bare);
	col = mix(col, lead_color, lead * 0.65);
	ALBEDO = col;
	// a lead smear is a dull grey film; too much metalness makes it mirror the ground and read black or white
	METALLIC = max(bare * 0.35, lead * 0.3);
	ROUGHNESS = mix(mix(0.62, 0.58, bare), 0.5, lead);
	SPECULAR = 0.5;
	vec3 n_paint = texture(paint_normal, UV * 1.5).rgb;
	vec3 n_steel = texture(steel_normal, UV * 2.0).rgb;
	NORMAL_MAP = mix(n_paint, n_steel, bare);
	NORMAL_MAP_DEPTH = 0.8;
}
