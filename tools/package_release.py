#!/usr/bin/env python3
"""Create a deterministic release ZIP from an explicit file allowlist."""

from __future__ import annotations

import hashlib
import io
import json
import platform
import re
import stat
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
import zlib
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
ARCHIVE_NAME = f"xhs-dual-codex-v{VERSION}.zip"
RELEASE_MANIFEST_NAME = f"xhs-dual-codex-v{VERSION}.release.json"
PACKAGE_PREFIX = f"xhs-dual-codex-v{VERSION}"

PACKAGE_FILES = (
    ".gitignore",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "TESTING.md",
    "CHANGELOG.md",
    "VERSION",
    "extension/manifest.json",
    "extension/popup.html",
    "extension/popup.css",
    "extension/popup.js",
    "extension/src/lib.js",
    "extension/src/injected.js",
    "extension/src/content.js",
    "extension/src/background.js",
    "extension/tests/lib.test.js",
    "extension/tests/release-guards.test.js",
    "builder/README.md",
    "builder/themes.json",
    "builder/build_codex_projects.py",
    "builder/build-codex-projects.command",
    "builder/build-codex-projects.cmd",
    "builder/tests/__init__.py",
    "builder/tests/fixtures/extension_private_export.json",
    "builder/tests/fixtures/extension_sanitized_export.json",
    "builder/tests/test_builder.py",
    "tools/package_release.py",
)

FORBIDDEN_PARTS = {".git", "__pycache__", "node_modules", ".env", ".DS_Store", "__MACOSX"}
EXECUTABLE_FILES = {
    "builder/build_codex_projects.py",
    "builder/build-codex-projects.command",
    "tools/package_release.py",
}
ZIP_TIMESTAMP = (2026, 8, 22, 0, 0, 0)
SEMVER_RE = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)")


def validate() -> None:
    if not SEMVER_RE.fullmatch(VERSION):
        raise RuntimeError(f"版本号异常: {VERSION!r}")
    if any(int(component) > 65535 for component in VERSION.split(".")):
        raise RuntimeError(f"版本号组件超出 Chrome Manifest 上限: {VERSION!r}")
    license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
    if "LICENSE" not in PACKAGE_FILES or not license_text.startswith("MIT License\n"):
        raise RuntimeError("MIT LICENSE 必须存在并进入发布清单")
    manifest = json.loads((ROOT / "extension/manifest.json").read_text(encoding="utf-8"))
    expected_manifest_keys = {
        "manifest_version", "name", "short_name", "description", "version",
        "minimum_chrome_version", "permissions", "host_permissions", "background",
        "action", "content_scripts", "content_security_policy",
    }
    if set(manifest) != expected_manifest_keys:
        raise RuntimeError(f"Manifest 顶层字段偏离白名单: {sorted(set(manifest) ^ expected_manifest_keys)}")
    if manifest.get("manifest_version") != 3:
        raise RuntimeError("只允许 Manifest V3")
    if manifest.get("version") != VERSION:
        raise RuntimeError("manifest.json 与 VERSION 不一致")
    if manifest.get("host_permissions") != ["https://www.xiaohongshu.com/*"]:
        raise RuntimeError("扩展域名权限超出发布白名单")
    if manifest.get("permissions") != ["storage", "alarms"]:
        raise RuntimeError("扩展权限必须精确为 storage 与 alarms")
    if manifest.get("minimum_chrome_version") != "120":
        raise RuntimeError("minimum_chrome_version 必须精确为 120")
    forbidden_manifest_keys = {
        "externally_connectable", "web_accessible_resources", "optional_permissions",
        "optional_host_permissions", "sandbox", "oauth2", "key", "update_url",
    }
    if forbidden_manifest_keys & set(manifest):
        raise RuntimeError(f"Manifest 含禁止字段: {sorted(forbidden_manifest_keys & set(manifest))}")
    if manifest.get("content_security_policy", {}).get("extension_pages") != "script-src 'self'; object-src 'none'":
        raise RuntimeError("扩展页面 CSP 未达到发布要求")
    expected_scripts = [
        {
            "matches": ["https://www.xiaohongshu.com/*"],
            "js": ["src/injected.js"],
            "run_at": "document_start",
            "world": "MAIN",
        },
        {
            "matches": ["https://www.xiaohongshu.com/*"],
            "js": ["src/lib.js", "src/content.js"],
            "run_at": "document_start",
            "world": "ISOLATED",
        },
    ]
    if manifest.get("content_scripts") != expected_scripts:
        raise RuntimeError("内容脚本范围、执行环境或加载顺序偏离发布白名单")
    if manifest.get("background") != {"service_worker": "src/background.js"}:
        raise RuntimeError("后台脚本配置偏离发布白名单")
    action = manifest.get("action", {})
    if set(action) != {"default_title", "default_popup"} or action.get("default_popup") != "popup.html":
        raise RuntimeError("弹窗配置偏离发布白名单")
    forbidden_permissions = {
        "cookies", "webRequest", "debugger", "tabs", "scripting", "history",
        "nativeMessaging", "declarativeNetRequest", "<all_urls>",
    }
    declared = set(manifest.get("permissions", [])) | set(manifest.get("host_permissions", []))
    unexpected = forbidden_permissions & declared
    if unexpected:
        raise RuntimeError(f"发现禁止权限: {sorted(unexpected)}")

    seen_paths: set[str] = set()
    seen_folded: set[str] = set()
    for relative in PACKAGE_FILES:
        relative_path = PurePosixPath(relative)
        if "\\" in relative or relative_path.is_absolute() or relative_path.as_posix() != relative:
            raise RuntimeError(f"发布清单路径不是规范相对路径: {relative}")
        if any(part in {"", ".", ".."} for part in relative_path.parts):
            raise RuntimeError(f"发布清单含路径穿越或空组件: {relative}")
        if any(part in FORBIDDEN_PARTS for part in relative_path.parts):
            raise RuntimeError(f"发布清单含禁止路径: {relative}")
        normalized = unicodedata.normalize("NFC", relative)
        folded = normalized.casefold()
        if normalized in seen_paths or folded in seen_folded:
            raise RuntimeError(f"发布清单含重复、大小写或 Unicode 冲突: {relative}")
        seen_paths.add(normalized)
        seen_folded.add(folded)
        path = ROOT
        for part in relative_path.parts:
            path = path / part
            if path.is_symlink():
                raise RuntimeError(f"发布路径含符号链接组件: {relative}")
        if not path.exists() or not path.is_file() or path.is_symlink():
            raise RuntimeError(f"发布文件缺失、不是普通文件或是符号链接: {relative}")
        try:
            path.resolve(strict=True).relative_to(ROOT.resolve(strict=True))
        except ValueError as exc:
            raise RuntimeError(f"发布文件越过项目根目录: {relative}") from exc

    html = (ROOT / "extension/popup.html").read_text(encoding="utf-8")
    for referenced in ("popup.css", "popup.js"):
        if referenced not in html or not (ROOT / "extension" / referenced).is_file():
            raise RuntimeError(f"扩展页面资源缺失: {referenced}")
    for script in manifest.get("content_scripts", []):
        for relative in script.get("js", []):
            if not (ROOT / "extension" / relative).is_file():
                raise RuntimeError(f"Manifest 引用缺失: {relative}")
    worker = manifest.get("background", {}).get("service_worker", "")
    if not worker or not (ROOT / "extension" / worker).is_file():
        raise RuntimeError("后台脚本缺失")
    packaged = set(PACKAGE_FILES)
    discovered_release_tests = {
        path.relative_to(ROOT).as_posix()
        for path in (ROOT / "extension/tests").glob("*.test.js")
        if path.is_file()
    }
    discovered_release_tests.update(
        path.relative_to(ROOT).as_posix()
        for path in (ROOT / "builder/tests").rglob("*.py")
        if path.is_file() and "__pycache__" not in path.parts
    )
    discovered_release_tests.update(
        path.relative_to(ROOT).as_posix()
        for path in (ROOT / "builder/tests/fixtures").rglob("*.json")
        if path.is_file()
    )
    omitted_release_tests = discovered_release_tests - packaged
    if omitted_release_tests:
        raise RuntimeError(
            f"发布测试或 fixture 未进入发布清单: {sorted(omitted_release_tests)}"
        )
    manifest_references = {
        "extension/popup.html", "extension/popup.css", "extension/popup.js",
        f"extension/{worker}",
        *(f"extension/{relative}" for script in manifest["content_scripts"] for relative in script["js"]),
    }
    missing_from_package = manifest_references - packaged
    if missing_from_package:
        raise RuntimeError(f"Manifest/弹窗引用未进入发布清单: {sorted(missing_from_package)}")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    readme_versions = re.findall(r"^版本：`([^`]+)`$", readme, flags=re.MULTILINE)
    changelog_versions = re.findall(
        r"^## ([0-9]+\.[0-9]+\.[0-9]+)(?:\s+—.*)?$", changelog, flags=re.MULTILINE
    )
    if readme_versions != [VERSION] or not changelog_versions or changelog_versions[0] != VERSION:
        raise RuntimeError("README、CHANGELOG 与 VERSION 不一致")


def run_release_tests(root: Path = ROOT) -> None:
    commands = (
        ("node", "--check", "extension/src/lib.js"),
        ("node", "--check", "extension/src/injected.js"),
        ("node", "--check", "extension/src/content.js"),
        ("node", "--check", "extension/src/background.js"),
        ("node", "--check", "extension/popup.js"),
        ("node", "--test", "extension/tests/lib.test.js", "extension/tests/release-guards.test.js"),
        (sys.executable, "-m", "unittest", "discover", "-s", "builder/tests", "-v"),
    )
    for command in commands:
        try:
            subprocess.run(command, cwd=root, check=True)
        except FileNotFoundError as exc:
            raise RuntimeError(f"发布测试缺少命令: {command[0]}") from exc
        except subprocess.CalledProcessError as exc:
            raise RuntimeError(f"发布测试失败: {' '.join(command)}") from exc


def read_package_files() -> dict[str, bytes]:
    return {relative: (ROOT / relative).read_bytes() for relative in sorted(PACKAGE_FILES)}


def release_manifest(file_data: dict[str, bytes]) -> tuple[bytes, list[dict[str, object]]]:
    files: list[dict[str, object]] = []
    for relative, data in file_data.items():
        files.append({
            "path": f"{PACKAGE_PREFIX}/{relative}",
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "mode": "0755" if relative in EXECUTABLE_FILES else "0644",
        })
    payload = {
        "schema_version": "xhs-dual-codex-release/1",
        "version": VERSION,
        "archive": ARCHIVE_NAME,
        "zip_timestamp_utc": "2026-08-22T00:00:00Z",
        "files": files,
    }
    return (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"), files


def expected_entry_bytes(file_data: dict[str, bytes], manifest_data: bytes) -> dict[str, bytes]:
    entries = {f"{PACKAGE_PREFIX}/{relative}": data for relative, data in file_data.items()}
    entries[f"{PACKAGE_PREFIX}/RELEASE-MANIFEST.json"] = manifest_data
    return entries


def verify_built_zip(path: Path, file_data: dict[str, bytes], manifest_data: bytes) -> None:
    expected = expected_entry_bytes(file_data, manifest_data)
    with zipfile.ZipFile(path, "r") as archive:
        if archive.testzip() is not None:
            raise RuntimeError("ZIP CRC 校验失败")
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)) or set(names) != set(expected):
            raise RuntimeError("ZIP 文件集合与发布清单不一致")
        folded: set[str] = set()
        for info in infos:
            name = info.filename
            pure = PurePosixPath(name)
            canonical = unicodedata.normalize("NFC", name).casefold()
            if ("\\" in name or pure.is_absolute() or pure.as_posix() != name
                    or any(part in {"", ".", ".."} for part in pure.parts)
                    or canonical in folded):
                raise RuntimeError(f"ZIP 含危险或冲突路径: {name}")
            folded.add(canonical)
            mode = info.external_attr >> 16
            expected_mode = 0o644 if name.endswith("/RELEASE-MANIFEST.json") else (
                0o755 if name.removeprefix(f"{PACKAGE_PREFIX}/") in EXECUTABLE_FILES else 0o644
            )
            if stat.S_IFMT(mode) != stat.S_IFREG or (mode & 0o777) != expected_mode:
                raise RuntimeError(f"ZIP entry 类型或 mode 异常: {name}")
            if info.date_time != ZIP_TIMESTAMP or info.compress_type != zipfile.ZIP_STORED:
                raise RuntimeError(f"ZIP entry 时间或压缩方式不确定: {name}")
            if archive.read(info) != expected[name]:
                raise RuntimeError(f"ZIP entry 内容与内部清单不一致: {name}")


def test_extracted_zip(path: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="xhs 发布 验证 ") as temporary:
        temporary_root = Path(temporary)
        with zipfile.ZipFile(path, "r") as archive:
            archive.extractall(temporary_root)
        extracted_root = temporary_root / PACKAGE_PREFIX
        for relative in PACKAGE_FILES:
            mode = 0o755 if relative in EXECUTABLE_FILES else 0o644
            (extracted_root / relative).chmod(mode)
        run_release_tests(extracted_root)


def build_environment() -> dict[str, str]:
    try:
        node_version = subprocess.run(
            ("node", "--version"), check=True, capture_output=True, text=True
        ).stdout.strip()
    except (FileNotFoundError, subprocess.CalledProcessError):
        node_version = "unknown"
    return {
        "python": platform.python_version(),
        "zlib_runtime": zlib.ZLIB_RUNTIME_VERSION,
        "node": node_version,
    }


def verify_existing_archive(path: Path, *, require_sidecars: bool = False) -> str:
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("待验证 ZIP 缺失、不是普通文件或是符号链接")
    archive_bytes = path.read_bytes()
    internal_name = f"{PACKAGE_PREFIX}/RELEASE-MANIFEST.json"
    with zipfile.ZipFile(io.BytesIO(archive_bytes), "r") as archive:
        if archive.testzip() is not None:
            raise RuntimeError("ZIP CRC 校验失败")
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)) or internal_name not in names:
            raise RuntimeError("ZIP 缺少内部发布清单或含重复路径")
        internal_data = archive.read(internal_name)
        internal = json.loads(internal_data)
        if (internal.get("schema_version") != "xhs-dual-codex-release/1"
                or internal.get("version") != VERSION
                or internal.get("archive") != path.name):
            raise RuntimeError("内部发布清单版本或归档名不一致")
        records = internal.get("files")
        if not isinstance(records, list):
            raise RuntimeError("内部发布清单 files 无效")
        expected_record_paths = {
            f"{PACKAGE_PREFIX}/{relative}" for relative in PACKAGE_FILES
        }
        expected = {internal_name, *expected_record_paths}
        folded: set[str] = set()
        for record in records:
            if not isinstance(record, dict) or not isinstance(record.get("path"), str):
                raise RuntimeError("内部发布清单记录无效")
        record_paths = [record["path"] for record in records]
        if len(record_paths) != len(set(record_paths)):
            raise RuntimeError("内部发布清单含重复路径")
        if set(record_paths) != expected_record_paths:
            raise RuntimeError("内部发布清单路径偏离本工具的固定发布白名单")
        if set(names) != expected:
            raise RuntimeError("ZIP 文件集合与内部发布清单不一致")
        records_by_path = {record["path"]: record for record in records}
        for info in infos:
            name = info.filename
            pure = PurePosixPath(name)
            canonical = unicodedata.normalize("NFC", name).casefold()
            if ("\\" in name or pure.is_absolute() or pure.as_posix() != name
                    or any(part in {"", ".", ".."} for part in pure.parts)
                    or canonical in folded):
                raise RuntimeError(f"ZIP 含危险或冲突路径: {name}")
            folded.add(canonical)
            mode = info.external_attr >> 16
            if (stat.S_IFMT(mode) != stat.S_IFREG or info.date_time != ZIP_TIMESTAMP
                    or info.compress_type != zipfile.ZIP_STORED):
                raise RuntimeError(f"ZIP entry 类型、时间或压缩方式异常: {name}")
            data = archive.read(info)
            if name == internal_name:
                if (mode & 0o777) != 0o644:
                    raise RuntimeError("内部发布清单 mode 异常")
                continue
            record = records_by_path[name]
            try:
                expected_mode = int(str(record["mode"]), 8)
                expected_bytes = int(record["bytes"])
            except (KeyError, TypeError, ValueError) as exc:
                raise RuntimeError(f"内部发布清单 mode/bytes 无效: {name}") from exc
            relative = name.removeprefix(f"{PACKAGE_PREFIX}/")
            fixed_mode = 0o755 if relative in EXECUTABLE_FILES else 0o644
            if str(record.get("mode")) != f"{fixed_mode:04o}" or expected_mode != fixed_mode:
                raise RuntimeError(f"内部发布清单 mode 偏离固定白名单: {name}")
            if ((mode & 0o777) != expected_mode or len(data) != expected_bytes
                    or hashlib.sha256(data).hexdigest() != record.get("sha256")):
                raise RuntimeError(f"ZIP entry 与内部发布清单不一致: {name}")
    digest = hashlib.sha256(archive_bytes).hexdigest()
    checksum = path.with_suffix(".zip.sha256")
    detached = path.with_name(f"{path.stem}.release.json")
    if require_sidecars and (not checksum.exists() or not detached.exists()):
        raise RuntimeError("缺少必须的 .zip.sha256 或 .release.json")
    if checksum.exists():
        if checksum.is_symlink() or not checksum.is_file():
            raise RuntimeError("外部 SHA-256 文件不是普通文件")
        checksum_digest = checksum.read_text(encoding="utf-8").strip().split(maxsplit=1)[0]
        if checksum_digest != digest:
            raise RuntimeError("外部 SHA-256 文件与 ZIP 不一致")
    if detached.exists():
        if detached.is_symlink() or not detached.is_file():
            raise RuntimeError("外部发布清单不是普通文件")
        payload = json.loads(detached.read_text(encoding="utf-8"))
        if (payload.get("archive_sha256") != digest
                or payload.get("internal_manifest_sha256") != hashlib.sha256(internal_data).hexdigest()):
            raise RuntimeError("外部发布清单与 ZIP 不一致")
    return digest


def build() -> tuple[Path, Path, Path, str]:
    validate()
    file_data = read_package_files()
    run_release_tests()
    validate()
    if read_package_files() != file_data:
        raise RuntimeError("源文件在发布测试期间发生变化，请重新运行")
    output = ROOT.parent / ARCHIVE_NAME
    temporary = output.with_suffix(".zip.tmp")
    checksum = output.with_suffix(".zip.sha256")
    release_info = output.with_name(RELEASE_MANIFEST_NAME)
    checksum_temporary = checksum.with_name(f".{checksum.name}.tmp")
    release_temporary = release_info.with_name(f".{release_info.name}.tmp")
    for target in (output, temporary, checksum, checksum_temporary, release_info, release_temporary):
        if target.is_symlink():
            raise RuntimeError(f"拒绝覆盖符号链接输出: {target.name}")
    for target in (temporary, checksum_temporary, release_temporary):
        if target.exists():
            target.unlink()
    manifest_data, _ = release_manifest(file_data)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as archive:
            for relative, data in file_data.items():
                info = zipfile.ZipInfo(f"{PACKAGE_PREFIX}/{relative}", date_time=ZIP_TIMESTAMP)
                info.compress_type = zipfile.ZIP_STORED
                mode = 0o755 if relative in EXECUTABLE_FILES else 0o644
                info.external_attr = (stat.S_IFREG | mode) << 16
                info.create_system = 3
                archive.writestr(info, data)
            info = zipfile.ZipInfo(f"{PACKAGE_PREFIX}/RELEASE-MANIFEST.json", date_time=ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.create_system = 3
            archive.writestr(info, manifest_data)
        verify_built_zip(temporary, file_data, manifest_data)
        test_extracted_zip(temporary)
        archive_bytes = temporary.read_bytes()
        digest = hashlib.sha256(archive_bytes).hexdigest()
        internal_digest = hashlib.sha256(manifest_data).hexdigest()
        detached = json.loads(manifest_data)
        detached["schema_version"] = "xhs-dual-codex-detached-release/1"
        detached["archive_sha256"] = digest
        detached["internal_manifest_sha256"] = internal_digest
        detached["build_environment"] = build_environment()
        detached_data = (json.dumps(detached, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
        checksum_temporary.write_text(f"{digest}  {output.name}\n", encoding="utf-8")
        release_temporary.write_bytes(detached_data)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != digest:
            raise RuntimeError("ZIP 在发布前发生变化")
        if read_package_files() != file_data:
            raise RuntimeError("源文件在 ZIP 发布前发生变化，请重新运行")
        if json.loads(release_temporary.read_text(encoding="utf-8")).get("archive_sha256") != digest:
            raise RuntimeError("外部发布清单校验失败")
        if checksum_temporary.read_text(encoding="utf-8").strip().split(maxsplit=1)[0] != digest:
            raise RuntimeError("外部 SHA-256 临时文件校验失败")
        temporary.replace(output)
        checksum_temporary.replace(checksum)
        release_temporary.replace(release_info)
        if verify_existing_archive(output, require_sidecars=True) != digest:
            raise RuntimeError("最终发布文件组校验失败")
    finally:
        for target in (temporary, checksum_temporary, release_temporary):
            if target.exists() and not target.is_symlink():
                target.unlink()
    return output, checksum, release_info, digest


def main() -> int:
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "--verify":
            target = Path(sys.argv[2]).expanduser()
            if target.is_symlink():
                raise RuntimeError("拒绝验证符号链接 ZIP")
            target = target.resolve(strict=True)
            digest = verify_existing_archive(target)
            print(target)
            print(digest)
            return 0
        if len(sys.argv) != 1:
            raise RuntimeError("用法：package_release.py [--verify <zip>] ")
        output, checksum, release_info, digest = build()
    except Exception as exc:  # noqa: BLE001 - command-line release gate
        print(f"发布失败：{exc}", file=sys.stderr)
        return 1
    print(output)
    print(checksum)
    print(release_info)
    print(digest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
