shader_type spatial;
// Corrugated cardboard backer with persistent holes. `field` (tiled, 2 px/mm): < 0.25 open, 0.25-0.55 dark crushed
// board around the opening, 0.58-0.95 frayed pale liner fibres, 1.0 untouched. COLOR.r = 0 marks the cut edges (no field lookup, corrugation stripes).
render_mode cull_back, diffuse_burley, specular_schlick_ggx;

uniform sampler2D albedo_tex : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D normal_tex : hint_normal, filter_linear_mipmap, repeat_enable;
uniform sampler2D orm_tex : filter_linear_mipmap, repeat_enable;
uniform sampler2DArray field : filter_linear_mipmap, repeat_disable;
uniform vec2 grid = vec2(10.0, 12.0);
uniform vec2 canvas_scale = vec2(1.0);
uniform vec2 size_m = vec2(0.61, 0.762);
uniform float tex_size_m = 0.6;
uniform vec3 tint = vec3(1.3, 1.3, 1.45);     // linear gain: brings the scan to kraft-liner reflectance (~0.4)
uniform vec3 fibre_color : source_color = vec3(0.80, 0.68, 0.50);

void fragment() {
	vec2 uvm = UV * size_m / tex_size_m;
	vec3 base = texture(albedo_tex, uvm).rgb;
	// kraft liner: the scan is very saturated; pull it toward a neutral tan (linear albedo ~ 0.46, 0.31, 0.15)
	base = mix(base, vec3(dot(base, vec3(0.2126, 0.7152, 0.0722))), 0.22) * tint;
	vec3 orm = texture(orm_tex, uvm).rgb;
	float fray = 0.0;
	if (COLOR.r > 0.5) {
		vec2 t = UV * canvas_scale * grid;
		vec2 cell = min(floor(t), grid - 1.0);
		float f = textureGrad(field, vec3(t - cell, cell.y * grid.x + cell.x), dFdx(t), dFdy(t)).r;
		if (f < 0.25) {
			discard;
		}
		// crushed liner and fluting around the small opening: in shadow, almost black at the hole
		float crush = 1.0 - smoothstep(0.50, 0.58, f);
		fray = (1.0 - smoothstep(0.58, 0.95, f)) * (1.0 - crush);
		base = mix(base, fibre_color, fray * 0.8);
		base = mix(base, base * mix(0.03, 0.15, smoothstep(0.25, 0.55, f)), crush);
	} else {
		// cut edge: the fluting shows as fine stripes
		float flute = 0.75 + 0.25 * sin(UV.x * 6.2832 * 110.0);
		base *= flute * 0.85;
	}
	ALBEDO = base;
	ROUGHNESS = max(orm.g, 0.75);
	AO = orm.r;
	SPECULAR = 0.25;
	NORMAL_MAP = texture(normal_tex, uvm).rgb;
	NORMAL_MAP_DEPTH = 1.0 + fray;
}
