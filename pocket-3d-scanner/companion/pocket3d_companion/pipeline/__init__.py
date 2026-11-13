"""Reconstruction pipeline worker of the Pocket 3D Scanner companion.

Runs as a separate process per job attempt (see docs/companion-protocol.md §4):
structure-from-motion with COLMAP (pycolmap), dense multi-view stereo, surface
reconstruction and texturing with OpenMVS, followed by evidence-preserving clean-up
and GLB packaging. Everything here runs on the companion computer — never on the phone.
"""
