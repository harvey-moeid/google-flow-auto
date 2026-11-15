"""Owner-controlled encrypted backup/restore for Chromium account profiles.

The archive is created locally, encrypted with scrypt-derived AES-256-GCM, and never
sent to the API, GitHub, D1, R2, or CI. Restore refuses to overwrite any existing
profile tree. The caller must hold HostLock for the entire operation.
"""
from __future__ import annotations
import os, re, shutil, stat, tempfile, zipfile
from pathlib import Path, PurePosixPath
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from worker.profile_audit import audit

MAGIC = b"GFA-PROFILE-BACKUP\x01"
SALT_BYTES, NONCE_BYTES, TAG_BYTES = 16, 12, 16
CHUNK_BYTES = 1024 * 1024
MAX_ARCHIVE_ENTRIES = 100_000
MAX_ARCHIVE_BYTES = 10 * 1024 * 1024 * 1024
_SLOT = re.compile(r"slot-(0[1-9]|10)\Z")


class ProfileBackupError(RuntimeError):
    """Backup or restore was rejected without changing the profile tree."""


def _key(passphrase: str, salt: bytes) -> bytes:
    if not isinstance(passphrase, str) or len(passphrase) < 12:
        raise ProfileBackupError("Backup passphrase must contain at least 12 characters")
    return Scrypt(salt=salt, length=32, n=2**14, r=8, p=1).derive(passphrase.encode("utf-8"))


def _encrypt_file(source: Path, destination: Path, passphrase: str) -> int:
    salt, nonce = os.urandom(SALT_BYTES), os.urandom(NONCE_BYTES)
    header = MAGIC + salt + nonce
    encryptor = Cipher(algorithms.AES(_key(passphrase, salt)), modes.GCM(nonce)).encryptor()
    encryptor.authenticate_additional_data(header)
    total = 0
    with source.open("rb") as src, destination.open("wb") as dst:
        os.chmod(destination, 0o600)
        dst.write(header)
        while chunk := src.read(CHUNK_BYTES):
            dst.write(encryptor.update(chunk))
            total += len(chunk)
        dst.write(encryptor.finalize())
        dst.write(encryptor.tag)
        dst.flush()
        os.fsync(dst.fileno())
    return total


def _decrypt_file(source: Path, destination: Path, passphrase: str) -> None:
    header_size = len(MAGIC) + SALT_BYTES + NONCE_BYTES
    size = source.stat().st_size
    if size < header_size + TAG_BYTES:
        raise ProfileBackupError("Backup file is truncated or has an unknown format")
    with source.open("rb") as src:
        header = src.read(header_size)
        if len(header) != header_size or not header.startswith(MAGIC):
            raise ProfileBackupError("Backup file is truncated or has an unknown format")
        salt = header[len(MAGIC):len(MAGIC) + SALT_BYTES]
        nonce = header[-NONCE_BYTES:]
        src.seek(-TAG_BYTES, os.SEEK_END)
        tag = src.read(TAG_BYTES)
        remaining = size - header_size - TAG_BYTES
        src.seek(header_size)
        decryptor = Cipher(algorithms.AES(_key(passphrase, salt)), modes.GCM(nonce, tag)).decryptor()
        decryptor.authenticate_additional_data(header)
        with destination.open("xb") as dst:
            os.chmod(destination, 0o600)
            while remaining:
                chunk = src.read(min(CHUNK_BYTES, remaining))
                if not chunk:
                    raise ProfileBackupError("Backup file is truncated")
                remaining -= len(chunk)
                dst.write(decryptor.update(chunk))
            try:
                dst.write(decryptor.finalize())
            except InvalidTag:
                raise ProfileBackupError("Backup authentication failed (wrong passphrase or modified file)") from None
            dst.flush()
            os.fsync(dst.fileno())


def _validated_profiles(data_dir: Path) -> Path:
    result = audit(data_dir)
    root = data_dir / "profiles"
    if not result.ok or result.unmarked or result.checked == 0:
        raise ProfileBackupError("Profiles must exist, have valid slot isolation markers, and pass the profile audit")
    return root


def _write_archive(profiles_root: Path, archive_path: Path) -> None:
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        for slot_dir in sorted(profiles_root.iterdir()):
            if slot_dir.is_symlink() or not slot_dir.is_dir() or not _SLOT.fullmatch(slot_dir.name):
                raise ProfileBackupError("Profile tree changed during backup; audit it and retry")
            for current, dirs, files in os.walk(slot_dir, followlinks=False):
                base = Path(current)
                for name in dirs:
                    if (base / name).is_symlink():
                        raise ProfileBackupError("Symlinks inside profiles are not allowed in backups")
                for name in files:
                    path = base / name
                    if path.is_symlink():
                        raise ProfileBackupError("Symlinks inside profiles are not allowed in backups")
                    if not path.is_file():
                        raise ProfileBackupError("Non-regular profile entries are not allowed in backups")
                    archive.write(path, path.relative_to(profiles_root.parent).as_posix())


def create_backup(data_dir: str | Path, output_path: str | Path, passphrase: str) -> dict:
    """Create a new encrypted archive; never overwrite an existing output."""
    data_dir, output = Path(data_dir).resolve(), Path(output_path).expanduser().absolute()
    profiles_root = _validated_profiles(data_dir)
    if output.exists() or output.is_symlink():
        raise ProfileBackupError("Backup destination already exists")
    if not output.parent.is_dir():
        raise ProfileBackupError("Backup destination directory does not exist")
    temp_archive = temp_encrypted = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".gfa-archive-", suffix=".zip", dir=data_dir, delete=False) as tmp:
            temp_archive = Path(tmp.name)
        os.chmod(temp_archive, 0o600)
        _write_archive(profiles_root, temp_archive)
        with tempfile.NamedTemporaryFile(prefix=".gfa-encrypted-", dir=output.parent, delete=False) as tmp:
            temp_encrypted = Path(tmp.name)
        os.chmod(temp_encrypted, 0o600)
        _encrypt_file(temp_archive, temp_encrypted, passphrase)
        with output.open("xb") as dst, temp_encrypted.open("rb") as src:
            os.chmod(output, 0o600)
            shutil.copyfileobj(src, dst, CHUNK_BYTES)
            dst.flush()
            os.fsync(dst.fileno())
        return {"ok": True, "operation": "backup", "bytes": output.stat().st_size}
    except FileExistsError:
        raise ProfileBackupError("Backup destination already exists") from None
    finally:
        for path in (temp_archive, temp_encrypted):
            if path is not None:
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass


def _extract_validated(archive_path: Path, staging_root: Path) -> None:
    seen, total = set(), 0
    with zipfile.ZipFile(archive_path, "r") as archive:
        infos = archive.infolist()
        if not infos or len(infos) > MAX_ARCHIVE_ENTRIES:
            raise ProfileBackupError("Backup archive has an invalid number of entries")
        for info in infos:
            name = info.filename
            parts = PurePosixPath(name).parts
            if (name in seen or "\\" in name or name.startswith("/") or len(parts) < 3
                or parts[0] != "profiles" or not _SLOT.fullmatch(parts[1])
                or any(p in ("", ".", "..") for p in parts)):
                raise ProfileBackupError("Backup archive contains an unsafe path")
            seen.add(name)
            mode = (info.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode):
                raise ProfileBackupError("Backup archive contains a symbolic link")
            if info.is_dir():
                continue
            if not stat.S_ISREG(mode) and mode != 0:
                raise ProfileBackupError("Backup archive contains a non-regular file")
            total += info.file_size
            if total > MAX_ARCHIVE_BYTES:
                raise ProfileBackupError("Backup archive exceeds the 10 GiB safety limit")
            target = staging_root.joinpath(*parts[1:])
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info, "r") as src, target.open("xb") as dst:
                while chunk := src.read(CHUNK_BYTES):
                    dst.write(chunk)
    result = audit(staging_root.parent)
    if not result.ok or result.unmarked or result.checked == 0:
        raise ProfileBackupError("Restored profile tree failed slot isolation validation")


def restore_backup(data_dir: str | Path, backup_path: str | Path, passphrase: str) -> dict:
    """Restore only into a data directory with no existing profile content."""
    data_dir, source = Path(data_dir).resolve(), Path(backup_path).expanduser().absolute()
    if source.is_symlink() or not source.is_file():
        raise ProfileBackupError("Backup source must be a regular file")
    destination = data_dir / "profiles"
    if destination.is_symlink():
        raise ProfileBackupError("Existing profiles path must not be a symlink")
    if destination.exists() and any(destination.iterdir()):
        raise ProfileBackupError("Restore refuses to overwrite existing profiles")
    data_dir.mkdir(parents=True, exist_ok=True)
    temp_archive = staging = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".gfa-restore-", suffix=".zip", dir=data_dir, delete=False) as tmp:
            temp_archive = Path(tmp.name)
        os.chmod(temp_archive, 0o600)
        _decrypt_file(source, temp_archive, passphrase)
        staging = Path(tempfile.mkdtemp(prefix=".gfa-staging-", dir=data_dir))
        os.chmod(staging, 0o700)
        staged_profiles = staging / "profiles"
        staged_profiles.mkdir(mode=0o700)
        _extract_validated(temp_archive, staged_profiles)
        if destination.exists():
            destination.rmdir()
        os.replace(staged_profiles, destination)
        return {"ok": True, "operation": "restore", "slots": audit(data_dir).checked}
    except (zipfile.BadZipFile, RuntimeError, OSError):
        raise ProfileBackupError("Backup archive is invalid or could not be restored") from None
    finally:
        if temp_archive is not None:
            try:
                temp_archive.unlink()
            except FileNotFoundError:
                pass
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)