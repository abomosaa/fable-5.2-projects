"""Validation of uploaded photographs.

The format is sniffed from the file content by Pillow (never from the client-supplied name),
only headers are parsed — pixel data is never decoded here — and the declared pixel count is
checked against the companion's limit before anything else touches the file, so a
decompression bomb costs nothing.
"""
from __future__ import annotations

import threading
import warnings
from pathlib import Path

from PIL import Image, UnidentifiedImageError

# Pillow format id → protocol format name. "MPO" is a JPEG with extra pictures attached
# (many phones store a gain map / depth map that way); the primary image is a plain JPEG.
_FORMATS = {"JPEG": "jpeg", "MPO": "jpeg", "PNG": "png", "WEBP": "webp", "HEIF": "heic"}
# Decoders Pillow may try. An MPO file is recognised by the JPEG plugin (it starts as a JPEG).
_WANTED_PLUGINS = ("JPEG", "PNG", "WEBP", "HEIF")
_open_formats: list[str] = []

_init_lock = threading.Lock()
_initialised = False


class ImageRejected(Exception):
    """The file is not an acceptable photograph; the message is safe to show to the user."""


def _init(max_pixels: int) -> None:
    global _initialised
    with _init_lock:
        # Pillow refuses to open anything above 2x this (DecompressionBombError); we reject
        # above 1x ourselves, so its warning in between is redundant.
        Image.MAX_IMAGE_PIXELS = int(max_pixels)
        if _initialised:
            return
        warnings.simplefilter("ignore", Image.DecompressionBombWarning)
        Image.init()   # register all of Pillow's own plugins (WebP is not among the preloaded ones)
        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
        except Exception:  # pragma: no cover - HEIC support is optional at import time
            pass
        # Image.open(formats=…) raises KeyError for ids that are not registered.
        _open_formats[:] = [f for f in _WANTED_PLUGINS if f in Image.OPEN]
        _initialised = True


FULL_DECODE_MAX_PIXELS = 30_000_000


def validate_image(path: Path, *, max_pixels: int, min_side: int) -> dict:
    """Return ``{"format", "width", "height"}`` or raise :class:`ImageRejected`."""
    _init(max_pixels)
    try:
        with Image.open(path, formats=_open_formats) as im:
            fmt = _FORMATS.get(im.format or "")
            width, height = im.size
            if fmt is None:
                raise ImageRejected("not a JPEG, PNG, WebP or HEIC image")
            if width < 1 or height < 1:
                raise ImageRejected("the image has no pixels")
            if width * height > max_pixels:
                raise ImageRejected(f"the image has more than {max_pixels} pixels")
            if min(width, height) < min_side:
                raise ImageRejected(f"the image is smaller than {min_side} pixels on its short side")
            im.verify()   # structural check (e.g. PNG chunk CRCs) without decoding pixels
        # Pixel data: a file cut off after its header (with a matching checksum of the cut file)
        # must not count as an image. JPEGs are decoded at 1/8 size (cheap, DCT scaling); other
        # formats are decoded fully when small enough, larger ones are left to the pipeline's
        # ingest stage, which decodes every photo anyway.
        with Image.open(path, formats=_open_formats) as im:
            if (im.format or "") in ("JPEG", "MPO"):
                im.draft("RGB", (max(1, width // 8), max(1, height // 8)))
                im.load()
            elif width * height <= FULL_DECODE_MAX_PIXELS:
                im.load()
    except ImageRejected:
        raise
    except Image.DecompressionBombError:
        raise ImageRejected(f"the image has more than {max_pixels} pixels") from None
    except UnidentifiedImageError:
        raise ImageRejected("not a JPEG, PNG, WebP or HEIC image") from None
    except Exception:
        # Pillow raises a wide variety of exceptions on damaged files (SyntaxError, OSError,
        # ValueError, struct.error, …); none of their texts are meant for users.
        raise ImageRejected("the file is not a decodable image") from None
    return {"format": fmt, "width": int(width), "height": int(height)}
