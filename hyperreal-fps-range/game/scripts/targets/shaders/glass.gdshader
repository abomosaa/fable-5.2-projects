shader_type spatial;
// Bottle glass: no diffuse surface colour at all - what you see is the scene behind, bent by the wall and
// filtered by the glass colour (more where the wall is seen at a grazing angle, i.e. thicker), plus mirror-like
// reflections of sun and sky. Fracture faces use the same shader with some roughness and a pale "frost".
render_mode blend_mix, depth_draw_always, cull_disabled, diffuse_burley, specular_schlick_ggx;

uniform vec3 tint : source_color = vec3(0.25, 0.55, 0.18);   // transmission through one wall, seen face-on
uniform float walls = 2.0;                                   // how many walls the view passes (2 for a whole bottle)
uniform float roughness : hint_range(0.0, 1.0) = 0.03;
uniform float refraction = 0.05;
uniform float frost : hint_range(0.0, 1.0) = 0.0;            // pale scattering on fracture faces
uniform sampler2D screen_tex : hint_screen_texture, filter_linear_mipmap, repeat_disable;

void fragment() {
	vec3 n = normalize(NORMAL);
	float ndv = clamp(dot(n, VIEW), 0.0, 1.0);
	float fres = pow(1.0 - ndv, 4.0);
	vec2 ofs = n.xy * refraction * (1.0 - ndv * 0.5);
	vec3 bg = textureLod(screen_tex, clamp(SCREEN_UV - ofs, vec2(0.001), vec2(0.999)), roughness * 8.0).rgb;
	// Beer-Lambert through the wall(s): path grows toward the silhouette
	float path = walls * mix(1.0, 3.0, pow(1.0 - ndv, 2.0));
	vec3 trans = bg * pow(tint, vec3(path));
	ALBEDO = mix(vec3(0.0), vec3(0.75, 0.8, 0.78), frost * 0.35);
	EMISSION = trans * (1.0 - fres * 0.6) * (1.0 - frost * 0.3) * EXPOSURE;
	METALLIC = 0.0;
	ROUGHNESS = roughness;
	SPECULAR = 0.55;
	ALPHA = 1.0;
}
