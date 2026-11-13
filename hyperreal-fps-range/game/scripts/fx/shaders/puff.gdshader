shader_type spatial;
// Lit, soft-edged billboard for dust and powder smoke. Lighting comes from the scene (sun with shadows + ambient),
// through a fake spherical normal so a puff has a lit and a shaded side; nothing is additive.
render_mode blend_mix, depth_draw_never, cull_disabled, specular_disabled, diffuse_lambert_wrap;

uniform sampler2D atlas : filter_linear_mipmap, repeat_disable;
uniform sampler2D depth_tex : hint_depth_texture, filter_nearest, repeat_disable;
uniform float softness = 0.12;
uniform float near_fade = 0.25;

varying vec2 v_cell;

void vertex() {
	float roll = INSTANCE_CUSTOM.x;
	v_cell = vec2(mod(INSTANCE_CUSTOM.z, 2.0), floor(INSTANCE_CUSTOM.z * 0.5));
	mat4 mat_world = mat4(normalize(INV_VIEW_MATRIX[0]), normalize(INV_VIEW_MATRIX[1]), normalize(INV_VIEW_MATRIX[2]), MODEL_MATRIX[3]);
	mat_world = mat_world * mat4(vec4(cos(roll), -sin(roll), 0.0, 0.0), vec4(sin(roll), cos(roll), 0.0, 0.0), vec4(0.0, 0.0, 1.0, 0.0), vec4(0.0, 0.0, 0.0, 1.0));
	MODELVIEW_MATRIX = VIEW_MATRIX * mat_world;
	MODELVIEW_MATRIX = MODELVIEW_MATRIX * mat4(vec4(length(MODEL_MATRIX[0].xyz), 0.0, 0.0, 0.0), vec4(0.0, length(MODEL_MATRIX[1].xyz), 0.0, 0.0), vec4(0.0, 0.0, length(MODEL_MATRIX[2].xyz), 0.0), vec4(0.0, 0.0, 0.0, 1.0));
	MODELVIEW_NORMAL_MATRIX = mat3(MODELVIEW_MATRIX);
}

void fragment() {
	float a = texture(atlas, (v_cell + UV) * 0.5).a;
	vec2 p = UV * 2.0 - 1.0;
	// view-space normal of a soft sphere, biased toward the viewer
	NORMAL = normalize(vec3(p.x, -p.y, sqrt(max(0.0, 1.0 - dot(p, p))) + 1.6));
	ALBEDO = COLOR.rgb;
	ROUGHNESS = 1.0;
	BACKLIGHT = COLOR.rgb * 0.25;
	float depth = textureLod(depth_tex, SCREEN_UV, 0.0).r;
	vec4 upos = INV_PROJECTION_MATRIX * vec4(SCREEN_UV * 2.0 - 1.0, depth, 1.0);
	float scene_z = -upos.z / upos.w;
	float frag_z = -VERTEX.z;
	float soft = clamp((scene_z - frag_z) / softness, 0.0, 1.0);
	float nearf = smoothstep(0.02, near_fade, frag_z);
	ALPHA = COLOR.a * a * soft * nearf;
}
