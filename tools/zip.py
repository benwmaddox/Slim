"""Deterministic, standard ZIP; all archive overhead counts toward the budget."""
import pathlib
import sys
import zipfile

source, target = map(pathlib.Path, sys.argv[1:3])
entries = sys.argv[3:] or ["index.html"]
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name in sorted(entries):
        if pathlib.PurePath(name).name != name:
            raise ValueError("ZIP entries must be top-level filenames")
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, (source / name).read_bytes(), compresslevel=9)
print(target.stat().st_size)
