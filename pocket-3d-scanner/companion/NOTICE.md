# Pocket 3D Scanner companion — third-party notice

This image contains, besides the companion's own code (`/opt/pocket3d`):

* **OpenMVS 2.3.0** (https://github.com/cdcseacave/openMVS, tag `v2.3.0`), licensed under the
  **GNU Affero General Public License v3.0** — binaries in `/opt/openmvs/bin`, licence text in
  `/opt/openmvs/licenses/OpenMVS-LICENSE`. Built from source by `companion/Containerfile` with
  two local one-line patches, both applied with `sed` in that file:
  1. `libs/Common/Util.h` — `Util::formatTime`: pass the remaining buffer size to `snprintf`
     (the original passes the full size at an offset and is aborted by glibc's fortify checks);
  2. `libs/MVS/Mesh.cpp` — `Mesh::SaveOBJ`: do not index `faceTexindices` when it is empty
     (single texture page).
  The Containerfile, with the pinned upstream revisions, is the corresponding source: rebuild
  with `podman build -f companion/Containerfile companion`.
* **VCGlib** (OpenMVS fork, commit `658ba36d0a5666650da6e066b4794efc5a463407`), **GPL-3.0** —
  linked into OpenMVS; licence text in `/opt/openmvs/licenses/VCGlib-LICENSE`.
* **CGAL** (GPL-3.0 / LGPL-3.0 parts), **Eigen** (MPL-2.0), **Ceres Solver** (BSD-3-Clause),
  **OpenCV** (Apache-2.0), **Boost** (BSL-1.0) — Ubuntu 24.04 packages used to build / run OpenMVS;
  their licence files are in `/usr/share/doc/<package>/copyright`.
* **COLMAP / pycolmap 4.2.1** (BSD-3-Clause), **Open3D 0.20.0** (MIT), NumPy, SciPy, Pillow,
  pillow-heif (bundles libheif/libde265 LGPL-3.0, x265 GPL-2.0), aiohttp, cryptography, qrcode,
  psutil and their dependencies — Python packages under `/opt/venv`; each package's licence is
  in its `*.dist-info` directory. Full list: `docs/licenses/companion-python-packages.md`.

The OpenMVS programs are run as separate processes; nothing in this image is a modified
derivative of them beyond the two patches above.
