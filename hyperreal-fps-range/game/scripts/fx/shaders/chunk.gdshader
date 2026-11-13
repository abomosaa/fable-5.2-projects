shader_type spatial;
// Small debris meshes (clods, stone chips, splinters, lead fragments, glass glints). Per-instance colour and
// INSTANCE_CUSTOM = (metallic, roughness, emission strength, unused).
render_mode cull_back, diffuse_burley, specular_schlick_ggx;

varying vec3 v_custom;

void vertex() {
	v_custom = INSTANCE_CUSTOM.xyz;
}

void fragment() {
	ALBEDO = COLOR.rgb;
	METALLIC = v_custom.x;
	ROUGHNESS = v_custom.y;
	EMISSION = COLOR.rgb * v_custom.z;
}
