"""Diagnosed pipeline failures (exit code 2 / 3) with user-facing recapture guidance."""
from __future__ import annotations


class PipelineError(Exception):
    """A reconstruction failure we can explain. `code` is machine readable, `guidance` is a
    list of concrete suggestions shown to the user."""
    exit_code = 2

    def __init__(self, code: str, message: str, guidance: list[str] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.guidance = guidance or []


class InputError(PipelineError):
    exit_code = 3


class Cancelled(Exception):
    pass


GUIDANCE_REGISTRATION = [
    "Take more photos with more overlap: neighbouring views should share about 70% of what they see "
    "(a step of roughly 10–15° around the object).",
    "Keep the object stationary and move the camera; do not rotate the object in your hands or on a "
    "plain turntable in front of a visible static background.",
    "Add texture to the surroundings (newspaper, patterned cloth under the object) if the object "
    "itself is plain, glossy or transparent.",
    "Avoid motion blur and strong exposure changes; lock focus/exposure if your phone supports it.",
]
