shader_type spatial;
// Alpha-tested vegetation (Poly Haven plant atlases): two-sided, cheap wind sway, back-lighting,
// per-instance tint via INSTANCE_CUSTOM.r (MultiMesh custom data) and distance fade-out for small plants.
render_mode blend_mix, depth_draw_opaque, cull_disabled, diffuse_burley, specular_schlick_ggx;
uniform sampler2D albedo_tex : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D normal_tex : hint_normal, filter_linear_mipmap, repeat_enable;
uniform sampler2D orm_tex : hint_default_white, filter_linear_mipmap, repeat_enable;
uniform vec3 tint : source_color = vec3(1.0);
uniform vec3 tint_dry : source_color = vec3(1.15, 1.0, 0.7);
uniform float brightness = 1.0;
uniform float alpha_cut = 0.45;
uniform float backlight = 0.35;
uniform float wind_strength = 0.02;
uniform float wind_speed = 1.3;
uniform float sway_height = 1.0;      // metres over which the sway ramps up
uniform float roughness_add = 0.0;
uniform float normal_strength = 1.0;
varying float inst_r;

void vertex() {
	inst_r = INSTANCE_CUSTOM.r;
	vec3 wp = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	vec3 origin = MODEL_MATRIX[3].xyz;
	float hgt = clamp((wp.y - origin.y) / sway_height, 0.0, 1.0);
	float ph = origin.x * 0.7 + origin.z * 0.9;
	float t = TIME * wind_speed;
	vec2 sway = vec2(sin(t + ph) + 0.5 * sin(t * 2.3 + wp.x * 1.7 + ph), cos(t * 0.8 + ph * 1.3) + 0.5 * sin(t * 2.9 + wp.z * 1.9)) * wind_strength * hgt * hgt;
	wp.xz += sway;
	VERTEX = (inverse(MODEL_MATRIX) * vec4(wp, 1.0)).xyz;
}

void fragment() {
	vec4 a = texture(albedo_tex, UV);
	vec3 col = a.rgb * brightness * mix(tint, tint * tint_dry, inst_r);
	ALBEDO = col;
	ALPHA = a.a;
	ALPHA_SCISSOR_THRESHOLD = alpha_cut;
	vec3 orm = texture(orm_tex, UV).rgb;
	ROUGHNESS = clamp(orm.g + roughness_add, 0.55, 1.0);
	AO = orm.r;
	SPECULAR = 0.2;
	NORMAL_MAP = texture(normal_tex, UV).rgb;
	NORMAL_MAP_DEPTH = normal_strength;
	BACKLIGHT = col * backlight;
}
