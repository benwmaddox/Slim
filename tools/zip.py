"""Write a deterministic ZIP from a directory.

Arguments after the target are either source names (``index.html``) or
explicit archive mappings (``index.html=page.html``).  Mappings let callers
keep a readable source name while giving the submitted archive its required
top-level ``index.html`` entry.
"""

import pathlib
import sys
import zipfile


def top_level_name(name: str) -> str:
    path = pathlib.PurePosixPath(name.replace("\\", "/"))
    if path.name != name or len(path.parts) != 1 or path.name in ("", ".", ".."):
        raise ValueError(f"ZIP names must be top-level filenames: {name!r}")
    return path.name


def entries(source: pathlib.Path, arguments: list[str]):
    for argument in arguments or ["index.html"]:
        if "=" in argument:
            archive_name, source_name = argument.split("=", 1)
        else:
            archive_name = source_name = argument
        archive_name = top_level_name(archive_name)
        source_path = (source / source_name).resolve()
        source_root = source.resolve()
        if source_path != source_root and source_root not in source_path.parents:
            raise ValueError(f"ZIP source escapes the input directory: {source_name!r}")
        if not source_path.is_file():
            raise FileNotFoundError(source_path)
        yield archive_name, source_path


def main() -> int:
    if len(sys.argv) < 3:
        raise SystemExit("usage: zip.py SOURCE_DIR TARGET_ZIP [ARCHIVE=SOURCE ...]")
    source = pathlib.Path(sys.argv[1])
    target = pathlib.Path(sys.argv[2])
    target.parent.mkdir(parents=True, exist_ok=True)
    selected = sorted(entries(source, sys.argv[3:]), key=lambda item: item[0])
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for archive_name, source_path in selected:
            info = zipfile.ZipInfo(archive_name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, source_path.read_bytes(), compresslevel=9)
    print(target.stat().st_size)
    return 0


if __name__ == "__main__":
    main()
