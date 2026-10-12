"""Download GuitarSet (annotations + mono mic audio) and the FretNet fold-0 weights.

Files go to data/ and models/ (both git-ignored). Only player 00 files are
extracted from the GuitarSet zips, because that is the held-out player for fold 0.
SHA-256 and size are printed for every download.

Usage: uv run fetch.py
"""

import hashlib
import shutil
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
MODELS = HERE / "models"

ZENODO = "https://zenodo.org/records/3371780/files"
FRETNET_ZIP = "https://github.com/cwitkowitz/guitar-transcription-continuous/files/12359237/FretNet.zip"
FRETNET_MEMBER = "FretNet/models/fold-0/model-2000.pt"
PLAYER = "00_"


def download(url: str, dest: Path) -> None:
    if dest.exists():
        print(f"have {dest.name}")
        return
    print(f"downloading {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, 7):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "smart-beat-research"})
            with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as out:
                shutil.copyfileobj(resp, out, 1 << 20)
            break
        except (urllib.error.URLError, TimeoutError) as err:
            print(f"  attempt {attempt} failed: {err}")
            if attempt == 6:
                raise
            time.sleep(10 * attempt)
    tmp.rename(dest)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def report(path: Path) -> None:
    print(f"  {path.name}: {path.stat().st_size} bytes, sha256 {sha256(path)}")


def extract_player(zip_path: Path, out_dir: Path) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    count = 0
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            name = Path(info.filename).name
            if info.is_dir() or not name.startswith(PLAYER):
                continue
            target = out_dir / name  # flat, so zip paths cannot escape out_dir
            with z.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
            count += 1
    return count


def main() -> int:
    DATA.mkdir(exist_ok=True)
    MODELS.mkdir(exist_ok=True)
    raw = DATA / "raw"
    raw.mkdir(exist_ok=True)

    for name, sub in (("annotation.zip", "annotation"), ("audio_mono-mic.zip", "audio_mono-mic")):
        z = raw / name
        download(f"{ZENODO}/{name}?download=1", z)
        report(z)
        n = extract_player(z, DATA / sub)
        print(f"  extracted {n} player 00 files to data/{sub}")

    fz = raw / "FretNet.zip"
    download(FRETNET_ZIP, fz)
    report(fz)
    target = MODELS / "model-2000.pt"
    if not target.exists():
        with zipfile.ZipFile(fz) as z, z.open(FRETNET_MEMBER) as src, open(target, "wb") as dst:
            shutil.copyfileobj(src, dst)
    report(target)
    print("Weights have no stated licence. Do not commit them or any ONNX export.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
