# Test resources

## `gltf-sample-assets/`

GLB files produced by tools other than this project, used to test `GlbReader` against real-world
files. They were downloaded unmodified from
<https://github.com/KhronosGroup/glTF-Sample-Assets> (branch `main`, commit
`8f492390ddc7a2ae221a1369ef560589cf8c70fb`, retrieved 2026-11-11), path
`Models/<name>/glTF-Binary/<name>.glb`. They are test inputs only: they are read by unit tests and
are not shipped in the app.

| File | SHA-256 | Copyright and licence (from the model's `LICENSE.md` / `README.md` upstream) |
|------|---------|------------------------------------------------------------------------------|
| `BoxTextured.glb` | `b510eca2e2ef33f62f9ed57d6e7ce2d10ebb2bdebc4a8e59d347719ba81abdf4` | © 2017 Cesium. [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/legalcode). The texture shows the Cesium logo, which is a trademark of Cesium used upstream under Cesium's legal mark usage guidelines (`LICENSES/LicenseRef-LegalMark-Cesium.txt` upstream); the CC-BY licence does not grant rights to the mark, so do not reuse this image for anything but testing. |
| `Duck.glb` | `65bf938f54d6073e619e76e007820bbf980cdc3dc0daec0d94830ffc4ae54ab5` | © 2006 Sony Computer Entertainment Inc. SCEA Shared Source License, Version 1.0 — full text in `Duck-LICENSE-SCEA.txt` next to the file (the licence asks for a copy to accompany redistribution). |

Facts about these files that the tests rely on were read from the files' JSON with an independent
script (not with `GlbReader`): BoxTextured has 24 vertices / 12 triangles under a node matrix that
rotates Z-up to Y-up, 16-bit indices, interleaved-stride buffer views and a 3750-byte PNG; Duck has
2399 vertices / 4212 triangles under a 0.01 uniform scale matrix, a sibling camera node, and a
16302-byte PNG.

All other test meshes are generated procedurally by `Fixtures.kt`.
