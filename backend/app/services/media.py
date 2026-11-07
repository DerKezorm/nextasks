"""What a file is, and what an uploaded photo tells about where it was taken, with what, and when.

Phones write the place (GPS), the device (make, model, serial numbers, lens) and much more into every photo. When the
operator leaves it on (``strip_location``, on by default), a photo keeps none of it: of all its metadata only the
orientation stays, so that a photo taken upright does not come back lying on its side, and the colour profile, so
that its colours stay right. Everything else is gone: place, device, times, software, comments, thumbnails, XMP,
IPTC.

Nothing is decoded and encoded again where it can be helped. The metadata is overwritten where it stands, with zeros
(binary) or blanks (XML), so the picture is byte for byte what the camera wrote; in JPEG, WebP, HEIC and TIFF the file
keeps its length and every offset inside it stays right. PNG has no offsets: its text chunks are left out. The Exif
block of a picture becomes a TIFF structure with a single entry, the orientation. Cleaning a clean picture changes
nothing, so the same photo cleaned twice is the same file (and has the same hash).

Only where a picture cannot be read to its end is it drawn anew (upright, without metadata); if even that fails, it is
left as it is and the log says so.

Covered: JPEG (Exif, XMP, IPTC, comments, other application blocks, further pictures appended such as gain maps),
PNG (eXIf, text chunks, time), WebP (EXIF, XMP), HEIC/HEIF/AVIF (Exif and XMP items), TIFF (everything but the tags
that describe the picture). Movies (MP4, QuickTime) lose place and device only, when ``strip`` is asked for one; the
upload of attachments does not do that (yet).
"""

from __future__ import annotations

import logging
import os
import re
import struct
import uuid
import zlib
from pathlib import Path

logger = logging.getLogger("nextasks.media")

LOCATION = "location"
DEVICE = "device"
#: A block that could not be read and was blanked whole.
METADATA = "metadata"
#: Part of the file could not be read (or was too large to read): what could be read was cleaned, the rest may still
#: hold a place or a device. The page says so.
UNCHECKED = "unchecked"

HEIF_BRANDS = {b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"msf1", b"mif2"}
AVIF_BRANDS = {b"avif", b"avis"}
#: Kinds that are pictures a browser shows by itself.
BROWSER_IMAGES = {"jpeg", "png", "gif", "webp", "avif", "bmp"}
VIDEOS = {"mp4", "mov"}
#: The pictures ``strip`` cleans down to their orientation.
PICTURES = {"jpeg", "png", "webp", "heic", "avif", "tiff"}
#: Pictures are edited in memory; larger ones are left as they are (and logged).
MAX_IMAGE_BYTES = 256 * 1024 * 1024
#: A movie header larger than this is not read (it would be a very unusual file).
MAX_MOOV_BYTES = 64 * 1024 * 1024


def sniff(head: bytes) -> str | None:
    """The kind of a file by its first bytes (at least 64 of them), never by its name."""
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if head.startswith(b"BM") and len(head) > 14:
        return "bmp"
    if head.startswith(b"%PDF-"):
        return "pdf"
    if head.startswith((b"II*\x00", b"MM\x00*")):
        return "tiff"
    if head[4:8] == b"ftyp":
        size = struct.unpack(">I", head[:4])[0]
        brands = {head[8:12]} | {head[at : at + 4] for at in range(16, min(size, len(head)) - 3, 4)}
        if brands & AVIF_BRANDS:
            return "avif"
        if brands & HEIF_BRANDS:
            return "heic"
        if head[8:12] == b"qt  ":
            return "mov"
        return "mp4"
    return None


class _Bad(ValueError):
    """A block of metadata that does not read as it should."""


# --- TIFF (the inside of Exif) --------------------------------------------------------------------------------------

_TYPE_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8}
_GPS = 0x8825
_EXIF = 0x8769
_INTEROP = 0xA005
#: Make, Model, Artist, HostComputer, MakerNote, ImageUniqueID, CameraOwnerName, BodySerialNumber, LensMake,
#: LensModel, LensSerialNumber.
_DEVICE_TAGS = {0x010F, 0x0110, 0x013B, 0x013C, 0x927C, 0xA420, 0xA430, 0xA431, 0xA433, 0xA434, 0xA435}


def _zero(buf: bytearray, start: int, end: int) -> bool:
    """Zeros over a range; whether anything was there. A range given the wrong way round (a broken size field) is
    refused rather than taken as empty."""
    if start < 0 or end < start or end > len(buf):
        raise _Bad
    had = any(buf[start:end])
    buf[start:end] = bytes(end - start)
    return had


def scrub_tiff(buf: bytearray, start: int, end: int) -> set[str]:
    """Remove the place and the device from the TIFF structure in ``buf[start:end]``, in place."""
    if end - start < 8:
        raise _Bad
    order = bytes(buf[start : start + 2])
    if order == b"II":
        fmt = "<"
    elif order == b"MM":
        fmt = ">"
    else:
        raise _Bad

    def u16(at: int) -> int:
        if at < start or at + 2 > end:
            raise _Bad
        return int(struct.unpack_from(fmt + "H", buf, at)[0])

    def u32(at: int) -> int:
        if at < start or at + 4 > end:
            raise _Bad
        return int(struct.unpack_from(fmt + "I", buf, at)[0])

    if u16(start + 2) != 42:
        raise _Bad
    removed: set[str] = set()
    seen: set[int] = set()
    queue: list[tuple[int, str]] = [(u32(start + 4), "main")]
    while queue:
        offset, kind = queue.pop()
        if offset == 0 or offset in seen:
            continue
        if len(seen) > 64:
            raise _Bad
        seen.add(offset)
        at = start + offset
        count = u16(at)
        if count > 2000 or at + 2 + 12 * count + 4 > end:
            raise _Bad
        following = u32(at + 2 + 12 * count)
        for number in range(count):
            entry = at + 2 + 12 * number
            tag, kind_of_value, items = u16(entry), u16(entry + 2), u32(entry + 4)
            size = _TYPE_SIZES.get(kind_of_value)
            if size is None:
                raise _Bad
            length = size * items
            value = entry + 8 if length <= 4 else start + u32(entry + 8)
            if length > 4 and (value < start or value + length > end):
                raise _Bad
            if kind == "gps":
                had = _zero(buf, value, value + length)
                _zero(buf, entry, entry + 12)
                if had:
                    removed.add(LOCATION)
            elif tag == _GPS:
                queue.append((u32(entry + 8), "gps"))
            elif tag in (_EXIF, _INTEROP) and kind_of_value in (4, 13):
                queue.append((u32(entry + 8), "sub"))
            elif tag in _DEVICE_TAGS and _zero(buf, value, value + length):
                removed.add(DEVICE)
        if kind == "gps":
            # No entries left: readers see an empty GPS directory (its entries and values are zeros already).
            struct.pack_into(fmt + "H", buf, at, 0)
        elif kind == "main":
            queue.append((following, "main"))
    return removed


_ORIENTATION = 0x0112


def _byte_order(buf: bytes | bytearray, start: int, end: int) -> str:
    if end - start < 8 or start < 0 or end > len(buf):
        raise _Bad
    fmt = {b"II": "<", b"MM": ">"}.get(bytes(buf[start : start + 2]))
    if fmt is None or struct.unpack_from(fmt + "H", buf, start + 2)[0] != 42:
        raise _Bad
    return fmt


def _orientation(buf: bytes | bytearray, start: int, end: int, fmt: str) -> int | None:
    """The orientation (1 to 8) in the first directory of a TIFF structure; None without one or when it cannot be
    read."""
    first = start + struct.unpack_from(fmt + "I", buf, start + 4)[0]
    if first < start + 8 or first + 2 > end:
        return None
    count = struct.unpack_from(fmt + "H", buf, first)[0]
    for number in range(count):
        entry = first + 2 + 12 * number
        if entry + 12 > end:
            return None
        tag, kind_of_value, items = struct.unpack_from(fmt + "HHI", buf, entry)
        if tag == _ORIENTATION:
            value = int(struct.unpack_from(fmt + "H", buf, entry + 8)[0])
            return value if kind_of_value == 3 and items == 1 and 1 <= value <= 8 else None
    return None


def minimal_tiff(fmt: str, orientation: int | None) -> bytes:
    """A TIFF structure with one directory holding the orientation and nothing else (none without one)."""
    header = (b"II" if fmt == "<" else b"MM") + struct.pack(fmt + "HI", 42, 8)
    if orientation is None:
        return header + struct.pack(fmt + "HI", 0, 0)
    return header + struct.pack(fmt + "HHHIHHI", 1, _ORIENTATION, 3, 1, orientation, 0, 0)


def exif_orientation(buf: bytes | bytearray, start: int, end: int) -> tuple[str, int | None]:
    """Byte order and orientation of the Exif (a TIFF structure) in ``buf[start:end]``; big-endian and None when it
    cannot be read."""
    try:
        fmt = _byte_order(buf, start, end)
        return fmt, _orientation(buf, start, end, fmt)
    except (_Bad, struct.error):
        return ">", None


def minimal_exif(buf: bytearray, start: int, end: int) -> set[str]:
    """The Exif in ``buf[start:end]`` becomes a TIFF structure with one entry, the orientation, followed by zeros:
    place, device, times, maker notes, the thumbnail, all gone. The block keeps its length. What was there is
    returned (``location``, ``device``, ``metadata``)."""
    if start < 0 or end < start or end > len(buf):
        raise _Bad
    fmt, orientation = exif_orientation(buf, start, end)
    new = bytearray(end - start)
    small = minimal_tiff(fmt, orientation)
    if len(small) <= len(new):
        new[: len(small)] = small
    if new == buf[start:end]:
        return set()
    probe = bytearray(buf[start:end])
    try:
        found = scrub_tiff(probe, 0, len(probe))
    except (_Bad, struct.error):
        found = set()
    buf[start:end] = new
    return found | {METADATA}


def _blank(buf: bytearray, start: int, end: int) -> set[str]:
    """Blanks over a block of XML (XMP); whether anything was there."""
    if start < 0 or end < start or end > len(buf):
        raise _Bad
    if not bytes(buf[start:end]).strip(b" "):
        return set()
    buf[start:end] = b" " * (end - start)
    return {METADATA}


# --- XMP ------------------------------------------------------------------------------------------------------------

_XMP_LOCATION = re.compile(rb"gps|location|city|country|latitude|longitude", re.IGNORECASE)
_XMP_DEVICE = re.compile(rb"make|model|serial|lens|owner", re.IGNORECASE)


def blank_xmp(buf: bytearray, start: int, end: int) -> set[str]:
    """An XMP packet that names a place or a device becomes blanks; one that does not stays as it is."""
    packet = bytes(buf[start:end])
    removed = set()
    if _XMP_LOCATION.search(packet):
        removed.add(LOCATION)
    if _XMP_DEVICE.search(packet):
        removed.add(DEVICE)
    if removed:
        buf[start:end] = b" " * (end - start)
    return removed



# --- Picture formats ------------------------------------------------------------------------------------------------

_XMP_NS = b"http://ns.adobe.com/xap/1.0/\x00"
_XMP_EXTENSION = b"http://ns.adobe.com/xmp/extension/\x00"
_PHOTOSHOP = b"Photoshop 3.0\x00"


#: Application blocks a JPEG needs to look right: JFIF, the colour profile, the index of further pictures (MPF, as
#: for gain maps) and Adobe's colour transform. Every other application block and every comment becomes zeros.
_JPEG_KEEP = ((0xE0, b"JFIF\x00"), (0xE2, b"ICC_PROFILE\x00"), (0xE2, b"MPF\x00"), (0xEE, b"Adobe"))


def _jpeg_stream(buf: bytearray, at: int) -> tuple[set[str], int | None]:
    """The blocks before the picture data of the JPEG starting at ``at``: what was removed, and where its picture
    data begins (None when the stream ended or broke before it, then with ``unchecked``)."""
    removed: set[str] = set()
    if buf[at : at + 2] != b"\xff\xd8":
        return {UNCHECKED}, None
    at += 2
    while at + 4 <= len(buf):
        if buf[at] != 0xFF:
            return removed | {UNCHECKED}, None
        marker = buf[at + 1]
        if marker == 0xFF:
            at += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:
            at += 2
            continue
        if marker == 0xDA:  # the picture data begins
            return removed, at
        if marker == 0xD9:
            return removed, None
        length = struct.unpack_from(">H", buf, at + 2)[0]
        begin, stop = at + 4, at + 2 + length
        if length < 2 or stop > len(buf):
            return removed | {UNCHECKED}, None
        if 0xE0 <= marker <= 0xEF or marker == 0xFE:
            content = bytes(buf[begin : begin + 40])
            if marker == 0xE1 and content.startswith(b"Exif\x00\x00"):
                removed |= minimal_exif(buf, begin + 6, stop)
            elif marker == 0xE1 and content.startswith(_XMP_NS):
                removed |= _blank(buf, begin + len(_XMP_NS), stop)
            elif marker == 0xE1 and content.startswith(_XMP_EXTENSION):
                removed |= _blank(buf, begin + len(_XMP_EXTENSION), stop)
            elif not any(marker == kept and content.startswith(prefix) for kept, prefix in _JPEG_KEEP) and _zero(
                buf, begin, stop
            ):
                # IPTC (city, country, the photographer), comments, maker blocks, content credentials.
                removed.add(METADATA)
        at = stop
    return removed | {UNCHECKED}, None


def _jpeg(buf: bytearray) -> set[str]:
    """The picture, and every further JPEG appended right after it (MPF: gain maps, depth, the second picture of a
    stereo photo), each with Exif of its own."""
    removed: set[str] = set()
    at = 0
    while True:
        found, scan = _jpeg_stream(buf, at)
        removed |= found
        if scan is None:
            break
        # Inside the picture data a 0xFF is always followed by 0x00 or a restart marker: the first end marker after
        # the start of the data is the end of this picture.
        end = buf.find(b"\xff\xd9", scan)
        if end < 0:
            break
        at = end + 2
        if buf[at : at + 3] != b"\xff\xd8\xff":
            break
    # A motion photo (Pixel, Samsung) carries a whole movie after the picture, with a place of its own.
    return removed | _trailing_movies(buf, at)


#: Text (author, comments, XMP, Exif as hex), the time of the last change, content credentials.
_PNG_DROP = {b"tEXt", b"zTXt", b"iTXt", b"tIME", b"caBX"}


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def _png(buf: bytearray) -> set[str]:
    """Rewritten chunk by chunk (PNG has no offsets): text and time left out, the Exif down to its orientation,
    nothing after the end."""
    removed: set[str] = set()
    out = bytearray(buf[:8])
    at = 8
    while True:
        if at + 12 > len(buf):
            raise _Bad  # no end chunk: cut off
        length = struct.unpack_from(">I", buf, at)[0]
        kind = bytes(buf[at + 4 : at + 8])
        stop = at + 8 + length
        if stop + 4 > len(buf):
            raise _Bad
        if kind in _PNG_DROP:
            removed.add(METADATA)
        elif kind == b"eXIf":
            fmt, orientation = exif_orientation(buf, at + 8, stop)
            small = minimal_tiff(fmt, orientation) if orientation is not None else b""
            if small:
                out += _png_chunk(kind, small)
            if small != bytes(buf[at + 8 : stop]):
                removed.add(METADATA)
        else:
            out += buf[at : stop + 4]
        at = stop + 4
        if kind == b"IEND":
            break
    if at < len(buf):
        removed.add(METADATA)  # whatever lies after the end, nobody shows it
    buf[:] = out
    return removed


def _webp(buf: bytearray) -> set[str]:
    removed: set[str] = set()
    end = min(len(buf), 8 + struct.unpack_from("<I", buf, 4)[0])
    at = 12
    while at + 8 <= end:
        kind = bytes(buf[at : at + 4])
        size = struct.unpack_from("<I", buf, at + 4)[0]
        begin, stop = at + 8, at + 8 + size
        if stop > end:
            raise _Bad
        if kind == b"EXIF":
            skip = 6 if buf[begin : begin + 6] == b"Exif\x00\x00" else 0
            removed |= minimal_exif(buf, begin + skip, stop)
        elif kind == b"XMP ":
            removed |= _blank(buf, begin, stop)
        at = stop + (size & 1)
    return removed


def _boxes(buf: bytes | bytearray, start: int, end: int) -> list[tuple[bytes, int, int, int]]:
    """ISO base media boxes between ``start`` and ``end``: (type, box start, content start, box end)."""
    found = []
    at = start
    while at + 8 <= end:
        size = struct.unpack_from(">I", buf, at)[0]
        kind = bytes(buf[at + 4 : at + 8])
        header = 8
        if size == 1:
            if at + 16 > end:
                break
            size = struct.unpack_from(">Q", buf, at + 8)[0]
            header = 16
        elif size == 0:
            size = end - at
        if size < header or at + size > end:
            break
        found.append((kind, at, at + header, at + size))
        at += size
    return found


def _heif(buf: bytearray) -> set[str]:
    """HEIC, HEIF and AVIF keep Exif and XMP as items: found through the item list and their places in the file."""
    meta = next((box for box in _boxes(buf, 0, len(buf)) if box[0] == b"meta"), None)
    if meta is None:
        return set()
    children = _boxes(buf, meta[2] + 4, meta[3])  # meta is a full box: version and flags first
    items: dict[int, bytes] = {}
    extents: dict[int, list[tuple[int, int, int]]] = {}
    idat = next((box for box in children if box[0] == b"idat"), None)
    for kind, _box, content, stop in children:
        if kind == b"iinf":
            version = buf[content]
            first = content + 4 + (2 if version == 0 else 4)
            for entry_kind, _eb, entry, entry_end in _boxes(buf, first, stop):
                if entry_kind != b"infe" or buf[entry] < 2:
                    continue
                wide = buf[entry] >= 3
                item_id = struct.unpack_from(">I" if wide else ">H", buf, entry + 4)[0]
                type_at = entry + 4 + (4 if wide else 2) + 2
                item_type = bytes(buf[type_at : type_at + 4])
                if item_type == b"mime":
                    # The item's name, then its content type, both ending in a NUL.
                    name_end = buf.find(b"\x00", type_at + 4, entry_end)
                    type_end = buf.find(b"\x00", name_end + 1, entry_end) if name_end >= 0 else -1
                    content_type = bytes(buf[name_end + 1 : type_end]) if type_end >= 0 else b""
                    if b"rdf+xml" in content_type.lower() or b"xmp" in content_type.lower():
                        items[item_id] = b"xmp"
                elif item_type == b"Exif":
                    items[item_id] = b"Exif"
        elif kind == b"iloc":
            version = buf[content]
            sizes = buf[content + 4]
            offset_size, length_size = sizes >> 4, sizes & 15
            more = buf[content + 5]
            base_size, index_size = more >> 4, (more & 15) if version in (1, 2) else 0
            at = content + 6
            count = struct.unpack_from(">H" if version < 2 else ">I", buf, at)[0]
            at += 2 if version < 2 else 4

            def number(width: int, position: int) -> int:
                return int.from_bytes(buf[position : position + width], "big") if width else 0

            for _ in range(count):
                # The count comes from the file: the box's end bounds the loop, not the number.
                if at >= stop:
                    break
                item_id = number(2 if version < 2 else 4, at)
                at += 2 if version < 2 else 4
                method = 0
                if version in (1, 2):
                    method = number(2, at) & 15
                    at += 2
                at += 2  # data reference index
                base = number(base_size, at)
                at += base_size
                extent_count = number(2, at)
                at += 2
                for _extent in range(extent_count):
                    if at >= stop:
                        break
                    at += index_size
                    offset = number(offset_size, at)
                    at += offset_size
                    length = number(length_size, at)
                    at += length_size
                    extents.setdefault(item_id, []).append((method, base + offset, length))
    removed: set[str] = set()
    for item_id, item_kind in items.items():
        for method, offset, length in extents.get(item_id, []):
            if method == 1 and idat is not None:
                start = idat[2] + offset
            elif method == 0:
                start = offset
            else:
                continue
            stop = min(len(buf), start + length) if length else len(buf)
            if start >= stop:
                continue
            if item_kind == b"Exif":
                # The item starts with the distance to the TIFF header ("Exif\0\0" usually sits in between).
                skip = struct.unpack_from(">I", buf, start)[0] if stop - start >= 4 else 0
                removed |= minimal_exif(buf, min(start + 4 + skip, stop), stop)
            else:
                removed |= _blank(buf, start, stop)
    # Boxes of a movie among the picture's (a motion photo), and a movie appended after them.
    return removed | _scrub_boxes(buf, 0, len(buf)) | _trailing_movies(buf, 12)


#: The tags of a TIFF file that describe its picture: size, samples, compression, where the strips and tiles lie,
#: colours (the colour profile, 0x8773, too), resolution, orientation. Everything else goes: make, model, software,
#: times, artist, copyright, description, XMP (700), IPTC (0x83BB), Photoshop's blocks (0x8649), Exif and GPS.
_TIFF_KEEP = {
    254, 255, 256, 257, 258, 259, 262, 263, 264, 265, 266, 273, 274, 277, 278, 279, 280, 281, 282, 283, 284, 290, 291,
    292, 293, 296, 301, 317, 318, 319, 320, 321, 322, 323, 324, 325, 332, 338, 339, 340, 341, 342, 347, 512, 513, 514,
    515, 517, 518, 519, 520, 521, 529, 530, 531, 532, 0x8773,
}
#: SubIFDs: further pictures of the file (DNG keeps its raw data there), cleaned like the first.
_SUB_IFDS = 0x014A
#: DNG describes its raw data with tags from 50706 on; those that name the camera or the shot go.
_DNG_FIRST, _DNG_LAST = 50706, 52000
_DNG_DROP = {50708, 50709, 50735, 50740, 50781, 50827, 50828}
#: Directories that hang off a tag and go with it.
_POINTERS = {_EXIF, _GPS, _INTEROP, _SUB_IFDS}


def _tiff_kept(tag: int) -> bool:
    return tag in _TIFF_KEEP or tag == _SUB_IFDS or (_DNG_FIRST <= tag <= _DNG_LAST and tag not in _DNG_DROP)


def _tiff(buf: bytearray) -> set[str]:
    """A TIFF file: every directory keeps the tags that describe its picture, in their order; the entries of the
    others and their values become zeros, as do the directories (Exif, GPS) that hang off them."""
    end = len(buf)
    fmt = _byte_order(buf, 0, end)
    removed: set[str] = set()
    seen: set[int] = set()

    def u16(at: int) -> int:
        if at < 0 or at + 2 > end:
            raise _Bad
        return int(struct.unpack_from(fmt + "H", buf, at)[0])

    def u32(at: int) -> int:
        if at < 0 or at + 4 > end:
            raise _Bad
        return int(struct.unpack_from(fmt + "I", buf, at)[0])

    def entries(at: int) -> list[tuple[int, int, int, int, int]]:
        """(tag, type, count, where the value lies, its length) of each entry of the directory at ``at``."""
        if at in seen or len(seen) > 256:
            raise _Bad
        seen.add(at)
        count = u16(at)
        if count > 4000 or at + 2 + 12 * count + 4 > end:
            raise _Bad
        found = []
        for number in range(count):
            entry = at + 2 + 12 * number
            tag, kind_of_value, items = u16(entry), u16(entry + 2), u32(entry + 4)
            size = _TYPE_SIZES.get(kind_of_value)
            if size is None:
                raise _Bad
            length = size * items
            value = entry + 8 if length <= 4 else u32(entry + 8)
            if length > 4 and (value < 8 or value + length > end):
                raise _Bad
            found.append((tag, kind_of_value, items, value, length))
        return found

    def offsets(kind_of_value: int, items: int, value: int) -> list[int]:
        width = 2 if kind_of_value == 3 else 4
        return [u16(value + width * n) if width == 2 else u32(value + width * n) for n in range(items)]

    def forget(at: int) -> None:
        """A directory nobody points to any more: zeros over it, its values and what hangs off it."""
        if at == 0:
            return
        listed = entries(at)
        for tag, kind_of_value, items, value, length in listed:
            if tag in _POINTERS and kind_of_value in (3, 4, 13):
                for inner in offsets(kind_of_value, items, value):
                    forget(inner)
            if tag in _DEVICE_TAGS:
                removed.add(DEVICE)
            if length > 4:
                _zero(buf, value, value + length)
        _zero(buf, at, at + 2 + 12 * len(listed) + 4)

    def clean(at: int) -> int:
        """The directory at ``at`` cleaned in place; returns the next one of its chain."""
        listed = entries(at)
        following = u32(at + 2 + 12 * len(listed))
        kept: list[bytes] = []
        for number, (tag, kind_of_value, items, value, length) in enumerate(listed):
            entry = at + 2 + 12 * number
            if _tiff_kept(tag):
                kept.append(bytes(buf[entry : entry + 12]))
                if tag == _SUB_IFDS and kind_of_value in (4, 13):
                    for inner in offsets(kind_of_value, items, value):
                        chained = inner
                        while chained:
                            chained = clean(chained)
                continue
            if tag == _GPS:
                removed.add(LOCATION)
            elif tag in _DEVICE_TAGS:
                removed.add(DEVICE)
            else:
                removed.add(METADATA)
            if tag in _POINTERS and kind_of_value in (4, 13):
                for inner in offsets(kind_of_value, items, value):
                    forget(inner)
            if length > 4:
                _zero(buf, value, value + length)
        if len(kept) < len(listed):
            # The kept entries close up (still in the order of their tags), the next pointer follows them.
            size = 2 + 12 * len(listed) + 4
            directory = struct.pack(fmt + "H", len(kept)) + b"".join(kept) + struct.pack(fmt + "I", following)
            buf[at : at + size] = directory + bytes(size - len(directory))
        return following

    at = u32(4)
    while at:
        at = clean(at)
    return removed


# --- Movies ---------------------------------------------------------------------------------------------------------

_XMP_UUID = uuid.UUID("be7acfcb-97a9-42e8-9c71-999491e3afac").bytes
#: QuickTime user data: place (©xyz, 3GPP loci) and device (©mak, ©mod).
_UDTA_LOCATION = {b"\xa9xyz", b"loci"}
_UDTA_DEVICE = {b"\xa9mak", b"\xa9mod"}
_KEY_LOCATION = re.compile(rb"location", re.IGNORECASE)
_KEY_DEVICE = re.compile(rb"\.(make|model|manufacturer|lens_model|camera\.identifier)$", re.IGNORECASE)
_CONTAINERS = {b"moov", b"trak", b"udta", b"mdia", b"minf", b"edts"}


def _meta_children(buf: bytearray, content: int, stop: int) -> int:
    """Where the boxes inside ``meta`` start: MP4 writes it as a full box, QuickTime does not."""
    if buf[content + 4 : content + 8] in (b"hdlr", b"keys", b"ilst"):
        return content
    return content + 4


def _scrub_meta(buf: bytearray, content: int, stop: int) -> set[str]:
    removed: set[str] = set()
    children = _boxes(buf, _meta_children(buf, content, stop), stop)
    private: dict[int, str] = {}
    for kind, _box, inner, end in children:
        if kind == b"keys":
            count = struct.unpack_from(">I", buf, inner + 4)[0]
            at = inner + 8
            for number in range(1, count + 1):
                if at + 8 > end:
                    break
                size = struct.unpack_from(">I", buf, at)[0]
                key = bytes(buf[at + 8 : at + size])
                if _KEY_LOCATION.search(key):
                    private[number] = LOCATION
                elif _KEY_DEVICE.search(key):
                    private[number] = DEVICE
                at += max(size, 8)
    for kind, _box, inner, end in children:
        if kind == b"ilst":
            for item_kind, _ib, item_inner, item_end in _boxes(buf, inner, end):
                number = struct.unpack(">I", item_kind)[0]
                if number in private:
                    for data_kind, _db, data_inner, data_end in _boxes(buf, item_inner, item_end):
                        # A data box: type and locale (8 bytes), then the value.
                        if data_kind == b"data" and _zero(buf, data_inner + 8, data_end):
                            removed.add(private[number])
                elif item_kind in _UDTA_LOCATION and _zero(buf, item_inner, item_end):
                    removed.add(LOCATION)
    return removed


def _scrub_boxes(buf: bytearray, start: int, end: int) -> set[str]:
    removed: set[str] = set()
    for kind, _box, content, stop in _boxes(buf, start, end):
        if kind in _CONTAINERS:
            removed |= _scrub_boxes(buf, content, stop)
        elif kind == b"meta":
            removed |= _scrub_meta(buf, content, stop)
        elif kind in _UDTA_LOCATION:
            if _zero(buf, content, stop):
                removed.add(LOCATION)
        elif kind in _UDTA_DEVICE:
            if _zero(buf, content, stop):
                removed.add(DEVICE)
        elif kind == b"uuid" and buf[content : content + 16] == _XMP_UUID:
            removed |= blank_xmp(buf, content + 16, stop)
        elif kind in _PADDING:
            # Free space may still hold an old movie header, from before the file was rearranged.
            _zero(buf, content, stop)
    return removed


_PADDING = {b"free", b"skip"}


def _trailing_movies(buf: bytearray, start: int) -> set[str]:
    """A movie appended to a picture (a motion photo): found by its ``ftyp`` box, cleaned like a movie."""
    removed: set[str] = set()
    at = start
    while (found := buf.find(b"ftyp", at)) >= 0:
        begin = found - 4
        brand = bytes(buf[found + 4 : found + 8])
        if begin >= start and re.fullmatch(rb"[0-9A-Za-z ]{4}", brand):
            size = struct.unpack_from(">I", buf, begin)[0]
            if 8 <= size <= len(buf) - begin:
                removed |= _scrub_boxes(buf, begin, len(buf))
        at = found + 4
    return removed


#: Top-level boxes of a movie that can hold a place or a device; everything else (the pictures) stays on disk.
_MOVIE_TOP = {b"moov", b"uuid", b"meta", b"udta"} | _PADDING


def _movie(path: Path) -> set[str]:
    """Only the movie header (``moov``) and other small top-level boxes are read and written, one after another;
    one that cannot be read or is too large is reported (``unchecked``), the others are still cleaned."""
    removed: set[str] = set()
    size = path.stat().st_size
    with open(path, "r+b") as handle:
        at = 0
        while at + 8 <= size:
            handle.seek(at)
            header = handle.read(16)
            box_size = struct.unpack_from(">I", header, 0)[0]
            kind = header[4:8]
            if box_size == 1:
                box_size = struct.unpack_from(">Q", header, 8)[0]
            elif box_size == 0:
                box_size = size - at
            if box_size < 8 or at + box_size > size:
                removed.add(UNCHECKED)
                break
            if kind in _MOVIE_TOP and box_size > MAX_MOOV_BYTES:
                if kind not in _PADDING:
                    logger.warning("Movie header too large to check for location, left as it is")
                    removed.add(UNCHECKED)
            elif kind in _MOVIE_TOP:
                handle.seek(at)
                original = handle.read(box_size)
                buf = bytearray(original)
                try:
                    removed |= _scrub_boxes(buf, 0, len(buf))
                except (struct.error, ValueError, IndexError):
                    removed.add(UNCHECKED)
                # What was cleaned before a broken part is kept: zeros never make a movie unreadable.
                if buf != original:
                    handle.seek(at)
                    handle.write(buf)
            at += box_size
    return removed


# --- The way in -----------------------------------------------------------------------------------------------------

_PICTURES = {"jpeg": _jpeg, "png": _png, "webp": _webp, "heic": _heif, "avif": _heif, "tiff": _tiff}


def strip(path: Path, kind: str | None) -> set[str]:
    """Clean the file at ``path`` in place: a picture (``PICTURES``) keeps of its metadata only the orientation and
    the colour profile, a movie (``VIDEOS``) loses place and device. Returns what was removed (``location``,
    ``device``, ``metadata``; ``redrawn`` when the picture had to be drawn anew, ``unchecked`` when it could not be
    cleaned). A file that is none of the known kinds is left alone."""
    if kind in VIDEOS:
        try:
            return _movie(path)
        except (OSError, struct.error, ValueError, IndexError) as exc:
            logger.warning("Could not check a movie for its location: %s", type(exc).__name__)
            return {UNCHECKED}
    handler = _PICTURES.get(kind or "")
    if handler is None:
        return set()
    size = path.stat().st_size
    if size > MAX_IMAGE_BYTES:
        logger.warning("Picture too large to check for its location, left as it is bytes=%s", size)
        return {UNCHECKED}
    original = path.read_bytes()
    buf = bytearray(original)
    try:
        removed = handler(buf)
    except (struct.error, ValueError, IndexError) as exc:
        logger.info("Could not read a picture's metadata to the end: %s", type(exc).__name__)
        removed = {UNCHECKED}
    if buf != original:
        with open(path, "r+b") as handle:
            handle.write(buf)
            handle.truncate()
            handle.flush()
            os.fsync(handle.fileno())
    if UNCHECKED in removed:
        # Part of it could not be read, so part of it may still tell a place: drawn anew from its pixels. What was
        # cleaned before the broken part stays if even that fails (zeros in metadata never break a picture).
        if _redraw(path, kind or ""):
            return (removed - {UNCHECKED}) | {REDRAWN}
        logger.warning("A picture could not be cleaned of its metadata to the end kind=%s", kind)
    return removed


#: The picture had to be drawn anew (``strip``).
REDRAWN = "redrawn"
_FORMATS = {"jpeg": "JPEG", "png": "PNG", "webp": "WEBP", "tiff": "TIFF", "heic": "HEIF", "avif": "AVIF"}


def _redraw(path: Path, kind: str) -> bool:
    """The picture at ``path`` drawn anew in its own format: upright, with its colour profile, without any other
    metadata. False when it cannot be read (or has several frames); the file is then as it was."""
    target = path.with_name(path.name + ".redraw")
    try:
        import pillow_heif
        from PIL import Image, ImageOps

        pillow_heif.register_heif_opener()
        with Image.open(path) as image:
            if getattr(image, "n_frames", 1) > 1 or image.width * image.height > MAX_WEBP_PIXELS:
                return False
            profile = image.info.get("icc_profile")
            upright = ImageOps.exif_transpose(image)
            upright.info = {}
            options: dict[str, object] = {"exif": b"", "xmp": b""}
            if profile:
                options["icc_profile"] = profile
            if kind == "jpeg":
                options["quality"] = 95
                if upright.mode not in ("RGB", "L", "CMYK"):
                    upright = upright.convert("RGB")
            elif kind in ("webp", "heic", "avif"):
                options["quality"] = 95
            upright.save(target, _FORMATS[kind], **options)
        os.replace(target, path)
        return True
    except Exception as exc:  # noqa: BLE001 - a broken or hostile picture fails in the decoder's own way
        logger.info("Could not draw a picture anew: %s", type(exc).__name__)
        target.unlink(missing_ok=True)
        return False


#: Pixels a picture may have for nextasks to draw a WebP of it (review before 1.0.0).
MAX_WEBP_PIXELS = 64_000_000


def to_webp(source: Path, target: Path) -> bool:
    """A WebP of a picture browsers cannot show (HEIC), turned upright, without any metadata. False when the
    picture cannot be read. Pillow refuses pictures of absurd pixel counts by itself (decompression bombs); a file
    larger than any photo is not even opened."""
    if source.stat().st_size > MAX_IMAGE_BYTES:
        return False
    try:
        import pillow_heif
        from PIL import Image, ImageOps

        pillow_heif.register_heif_opener()
        with Image.open(source) as image:
            # Read from the header, before a pixel is decoded: Pillow itself allows up to 178 million, which as RGBA
            # is 700 MB for one upload on a small NAS. 64 million is more than any phone takes by default.
            if image.width * image.height > MAX_WEBP_PIXELS:
                logger.info("No WebP of a picture larger than %s pixels", MAX_WEBP_PIXELS)
                return False
            upright = ImageOps.exif_transpose(image)
            profile = image.info.get("icc_profile")
            options: dict[str, object] = {"quality": 85, "method": 4, "exif": b"", "xmp": b""}
            if profile:
                options["icc_profile"] = profile
            upright.save(target, "WEBP", **options)
        return True
    except Exception as exc:  # noqa: BLE001 - a broken or hostile picture fails in the decoder's own way
        logger.warning("Could not make a WebP of a picture: %s", type(exc).__name__)
        return False
