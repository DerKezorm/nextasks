"""Photos and what they give away (``services/media.py``).

With ``strip_location`` on (the default) a photo attached to a task keeps of its metadata only the orientation and the
colour profile, on every way in: the web and the app, both through ``/api/app/1/files`` (pictures in notes are
attachments too; ``/api/v1`` takes no files). The server forms the hash after cleaning, so the row, the file under its
hash and the download agree, and the same photo sent again is the same file. Off: the photo stays byte for byte.
"""

from __future__ import annotations

import hashlib
import io
from pathlib import Path
from typing import Any

import pillow_heif
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageOps, PngImagePlugin

from app.db import SessionLocal
from app.services import files, media, settings_service

from .conftest import MEDIA
from .sync_helpers import API, make_reminder, new_id, person, private_space, put, state
from .test_app_devices import _device

pillow_heif.register_heif_opener()

MODEL = "Pocket Camera 9"
SERIAL = "SN-4711-0815"
#: What must not survive anywhere in a cleaned file.
TELLTALES = (b"Pocket", b"SN-4711", b"Snapper", b"2026:05", b"GPSLatitude", b"Somebody", b"Holiday at home")
XMP = ('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
       '<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="52,31.2N"/></rdf:RDF>'
       '</x:xmpmeta>')
KINDS = ["JPEG", "PNG", "WEBP", "TIFF", "HEIF"]


def exif() -> Image.Exif:
    """A place (GPS), a device (make, model, serial number, software), times, and the orientation 6 (turned)."""
    found = Image.Exif()
    found[0x010F] = "Pocketmaker"
    found[0x0110] = MODEL
    found[0x0131] = "Snapper 1.2"
    found[0x0132] = "2026:05:01 10:00:00"
    found[0x0112] = 6
    gps = found.get_ifd(0x8825)
    gps[1] = "N"
    gps[2] = (52.0, 31.0, 12.0)
    gps[3] = "E"
    gps[4] = (13.0, 24.0, 0.0)
    found.get_ifd(0x8769)[0xA431] = SERIAL
    found.get_ifd(0x8769)[0x9003] = "2026:05:01 10:00:00"
    return found


def photo(kind: str = "JPEG", *, width: int = 60, height: int = 30) -> bytes:
    """Left half red, right half blue, with everything a phone writes into it."""
    image = Image.new("RGB", (width, height), (220, 30, 30))
    image.paste((30, 30, 220), (width // 2, 0, width, height))
    out = io.BytesIO()
    if kind == "JPEG":
        image.save(out, "JPEG", exif=exif().tobytes(), xmp=XMP.encode(), comment=b"Holiday at home")
    elif kind == "PNG":
        info = PngImagePlugin.PngInfo()
        info.add_text("Author", "Somebody")
        info.add_itxt("XML:com.adobe.xmp", XMP)
        image.save(out, "PNG", exif=exif().tobytes(), pnginfo=info)
    elif kind == "WEBP":
        image.save(out, "WEBP", exif=exif().tobytes(), xmp=XMP.encode())
    elif kind == "TIFF":
        image.save(out, "TIFF", exif=exif().tobytes())
    elif kind == "HEIF":
        image.save(out, "HEIF", exif=exif().tobytes(), xmp=XMP.encode(), quality=90)
    return out.getvalue()


def told(data: bytes) -> dict[str, Any]:
    """What a reader other than nextasks's own (Pillow) finds in a picture."""
    with Image.open(io.BytesIO(data)) as image:
        found = image.getexif()
        upright = ImageOps.exif_transpose(image).convert("RGB")
        return {
            "tags": {tag: value for tag, value in found.items() if tag not in (0x8769, 0x8825)},
            "gps": dict(found.get_ifd(0x8825)),
            "exif": dict(found.get_ifd(0x8769)),
            "xmp": (image.info.get("xmp") or b"").strip(b" \x00") if isinstance(image.info.get("xmp"), bytes)
            else (image.info.get("xmp") or "").strip(),
            "upright": upright.size,
            "top": upright.getpixel((upright.width // 2, 2)),
            "bottom": upright.getpixel((upright.width // 2, upright.height - 3)),
            "telltales": [word for word in TELLTALES if word in data],
        }


def assert_clean(data: bytes) -> None:
    found = told(data)
    assert found["gps"] == {} and found["exif"] == {}, found
    assert set(found["tags"]) <= {0x0112} | ({256, 257, 258, 259, 262, 273, 277, 278, 279, 284, 296, 282, 283}
                                              if data[:2] in (b"II", b"MM") else set()), found["tags"]
    assert not found["xmp"], found["xmp"]
    assert found["telltales"] == []
    # Turned by its orientation: the 60 x 30 picture stands, red on top, blue below.
    assert found["upright"] == (30, 60)
    assert found["top"][0] > 150 and found["bottom"][2] > 150, found


@pytest.mark.parametrize("kind", KINDS)
def test_each_photo_as_it_came_tells_place_device_and_more(kind: str) -> None:
    """The test pictures carry what a phone writes, so the tests below prove something."""
    found = told(photo(kind))
    assert found["gps"], found
    assert found["tags"].get(0x0110) == MODEL or found["telltales"], found
    assert b"Pocket" in photo(kind)


# --- Photos: the way in -----------------------------------------------------------------------------------------


def upload(client: TestClient, reminder: str, data: bytes, attachment: str | None = None,
           op_id: str | None = None, name: str = "garden.jpg", mime: str = "image/jpeg") -> dict[str, Any]:
    answer = client.post(f"{API}/files", data={"id": attachment or new_id(), "reminder_id": reminder,
                                               "op_id": op_id or new_id()}, files={"file": (name, data, mime)})
    assert answer.status_code == 200, answer.text
    return answer.json()


def stored_files() -> list[Path]:
    return [entry for entry in MEDIA.iterdir() if entry.is_file() and files.HASH.match(entry.name)]


def check_way_in(client: TestClient, reader: TestClient, reminder: str, kind: str) -> None:
    original = photo(kind)
    attachment = new_id()
    result = upload(client, reminder, original, attachment)
    assert result["ok"], result
    data = result["current"]["data"]
    kept = files.path_of(data["hash"]).read_bytes()
    # The row, the file under its hash and the download agree, and it is not the photo as it came.
    assert data["hash"] == hashlib.sha256(kept).hexdigest() != hashlib.sha256(original).hexdigest()
    assert data["size"] == len(kept)
    down = reader.get(f"{API}/files/{attachment}")
    assert down.status_code == 200 and down.content == kept and down.headers["etag"] == f'"{data["hash"]}"'
    assert state(reader)[("attachment", attachment)]["data"]["hash"] == data["hash"]
    assert_clean(kept)
    assert not files.path_of(hashlib.sha256(original).hexdigest()).exists(), "the photo as it came is not kept"


@pytest.mark.parametrize("kind", KINDS)
def test_a_photo_from_the_web_arrives_without_place_device_or_anything_but_its_orientation(kind: str) -> None:
    _anna, anna = person("anna")
    _space, list_id = private_space(anna)
    check_way_in(anna, anna, make_reminder(anna, list_id, "Garden"), kind)


@pytest.mark.parametrize("kind", KINDS)
def test_a_photo_from_the_app_arrives_without_place_device_or_anything_but_its_orientation(kind: str) -> None:
    _anna, anna = person("anna")
    _space, list_id = private_space(anna)
    _key, phone = _device(anna)
    check_way_in(phone, anna, make_reminder(anna, list_id, "Garden"), kind)


def test_a_picture_in_a_note_is_an_attachment_and_cleaned_the_same() -> None:
    _anna, anna = person("anna")
    _space, list_id = private_space(anna)
    reminder = make_reminder(anna, list_id, "Garden")
    attachment = new_id()
    result = upload(anna, reminder, photo(), attachment, name="pasted.png", mime="image/png")
    assert put(anna, "reminder", reminder, {"notes": f"Look: ![pasted](attachment:{attachment})"})["ok"]
    assert_clean(files.path_of(result["current"]["data"]["hash"]).read_bytes())


def test_switched_off_a_photo_stays_as_it_came() -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"strip_location": False})
    _anna, anna = person("anna")
    _space, list_id = private_space(anna)
    original = photo()
    result = upload(anna, make_reminder(anna, list_id, "Garden"), original)
    assert result["current"]["data"]["hash"] == hashlib.sha256(original).hexdigest()
    assert files.path_of(result["current"]["data"]["hash"]).read_bytes() == original
    assert told(original)["gps"], "the place is still there"


def test_the_switch_is_on_from_the_start_and_the_operator_turns_it(client: TestClient, operator: object) -> None:
    assert client.get("/api/settings").json()["strip_location"] is True
    assert client.put("/api/settings", json={"strip_location": False}).json()["strip_location"] is False
    with SessionLocal() as db:
        assert settings_service.get(db, "strip_location") is False
    assert client.put("/api/settings", json={"strip_location": True}).json()["strip_location"] is True


def test_the_same_photo_sent_again_is_the_same_attachment_and_the_same_file() -> None:
    """The app keeps the photo as it came until the server answers; a retry, even under another op_id, sends the same
    bytes again. They are cleaned the same way, come to the same hash, and nothing is kept twice."""
    _anna, anna = person("anna")
    _space, list_id = private_space(anna)
    reminder = make_reminder(anna, list_id, "Garden")
    original, attachment, op_id = photo(), new_id(), new_id()
    first = upload(anna, reminder, original, attachment, op_id)
    assert first["ok"]
    again = upload(anna, reminder, original, attachment, op_id)
    assert again["ok"] and again["current"]["data"]["hash"] == first["current"]["data"]["hash"]
    other_op = upload(anna, reminder, original, attachment)
    assert other_op["ok"], "a retry under another op_id is not taken for another file"
    assert other_op["current"]["data"]["hash"] == first["current"]["data"]["hash"]
    assert len(stored_files()) == 1
    held = [item for (kind, _), item in state(anna).items() if kind == "attachment"]
    assert len(held) == 1


def test_a_photo_cleaned_already_stays_byte_for_byte() -> None:
    """Cleaning a clean photo changes nothing: a client that cleaned it before (and knows its hash) keeps that hash."""
    _anna, anna = person("anna")
    _space, list_id = private_space(anna)
    reminder = make_reminder(anna, list_id, "Garden")
    first = upload(anna, reminder, photo())
    clean = files.path_of(first["current"]["data"]["hash"]).read_bytes()
    second = upload(anna, reminder, clean)
    assert second["current"]["data"]["hash"] == hashlib.sha256(clean).hexdigest() == first["current"]["data"]["hash"]


def test_what_is_no_picture_is_left_alone() -> None:
    _anna, anna = person("anna")
    _space, list_id = private_space(anna)
    content = b"%PDF-1.4 GPSLatitude Pocket Camera\n" * 20
    result = upload(anna, make_reminder(anna, list_id, "Invoice"), content, name="a.pdf", mime="application/pdf")
    assert result["current"]["data"]["hash"] == hashlib.sha256(content).hexdigest()


# --- Photos: the cleaning itself --------------------------------------------------------------------------------


def clean(tmp_path: Path, data: bytes) -> tuple[bytes, set[str]]:
    path = tmp_path / "picture"
    path.write_bytes(data)
    removed = media.strip(path, media.sniff(data[:64]))
    return path.read_bytes(), removed


@pytest.mark.parametrize("kind", KINDS)
def test_the_pixels_stay_and_cleaning_twice_is_cleaning_once(tmp_path: Path, kind: str) -> None:
    original = photo(kind)
    once, removed = clean(tmp_path, original)
    assert removed and media.UNCHECKED not in removed
    twice, again = clean(tmp_path, once)
    assert twice == once and again == set()
    with Image.open(io.BytesIO(original)) as before, Image.open(io.BytesIO(once)) as after:
        assert before.convert("RGB").tobytes() == after.convert("RGB").tobytes()
    if kind != "PNG":
        assert len(once) == len(original), "offsets inside the file stay right"


def test_a_second_picture_appended_to_a_jpeg_is_cleaned_too(tmp_path: Path) -> None:
    """Gain maps and depth pictures (MPF) follow the picture as JPEGs of their own, with Exif of their own."""
    second = photo()
    first = io.BytesIO()
    Image.new("RGB", (8, 8), (10, 200, 10)).save(first, "JPEG")
    together = first.getvalue() + second
    out, _removed = clean(tmp_path, together)
    assert [word for word in TELLTALES if word in out] == []
    assert_clean(out[len(first.getvalue()):])


def test_a_picture_that_cannot_be_read_to_the_end_is_drawn_anew(tmp_path: Path,
                                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(buf: bytearray) -> set[str]:
        raise ValueError("cannot be read")

    monkeypatch.setitem(media._PICTURES, "jpeg", broken)
    out, removed = clean(tmp_path, photo())
    assert removed == {media.REDRAWN}
    assert_clean(out)


def test_a_png_keeps_no_text_and_nothing_after_its_end(tmp_path: Path) -> None:
    original = photo("PNG") + b"Somebody was here"
    out, _removed = clean(tmp_path, original)
    assert out.endswith(b"IEND\xaeB`\x82")
    assert_clean(out)


def test_every_kind_cleaned_is_one_the_server_knows() -> None:
    assert set(media._PICTURES) == media.PICTURES
    assert media.sniff(photo("TIFF")[:64]) == "tiff" and media.sniff(photo("HEIF")[:64]) == "heic"
