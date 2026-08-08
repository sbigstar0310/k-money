"""비밀번호 걸린 zip 해제.

뱅크샐러드 내보내기가 ZipCrypto 인지 AES 인지 확인되지 않았으므로 둘 다 처리한다.
표준 zipfile 은 ZipCrypto 만 읽을 수 있고, AES(compression type 99)는 pyzipper 가 필요하다.
"""

from __future__ import annotations

import logging
import zipfile
from dataclasses import dataclass
from pathlib import Path

import pyzipper

log = logging.getLogger(__name__)


class ZipUnlockError(RuntimeError):
    pass


@dataclass(frozen=True)
class ExtractResult:
    source: Path
    dest_dir: Path
    files: list[Path]
    encryption: str  # "none" | "zipcrypto" | "aes" | "unknown"


def _detect_encryption(path: Path) -> str:
    """압축 해제 전에 암호화 방식을 판별한다. 실패 원인을 정확히 말하기 위함."""
    try:
        with zipfile.ZipFile(path) as zf:
            infos = zf.infolist()
    except zipfile.BadZipFile as exc:
        raise ZipUnlockError(f"zip 파일이 아니거나 손상됐습니다: {path}") from exc

    if not infos:
        return "none"
    # flag_bits 0x1 = 암호화됨, compress_type 99 = AES (WinZip 확장)
    if any(i.compress_type == 99 for i in infos):
        return "aes"
    if any(i.flag_bits & 0x1 for i in infos):
        return "zipcrypto"
    return "none"


def _is_safe_member(name: str) -> bool:
    """zip slip 방지 — 절대경로나 상위 디렉토리 탈출을 거른다."""
    p = Path(name)
    return not p.is_absolute() and ".." not in p.parts


def _decode_name(info: zipfile.ZipInfo) -> str:
    """한글 파일명 복원.

    zip 스펙상 UTF-8 파일명은 general purpose flag 의 0x800 비트로 표시해야 하는데,
    많은 압축 도구가 이 비트를 세우지 않고 UTF-8 바이트를 그대로 넣는다. 그러면
    zipfile 이 CP437 로 디코딩해서 '가계부' 가 'Ω░ÇΩ│äδ╢Ç' 처럼 깨진다.
    원본 바이트를 되살려 UTF-8 → CP949 순으로 다시 시도한다.
    """
    if info.flag_bits & 0x800:
        return info.filename
    try:
        raw = info.filename.encode("cp437")
    except UnicodeEncodeError:
        return info.filename
    for encoding in ("utf-8", "cp949"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return info.filename


def extract(archive: Path, dest_dir: Path, password: str | None = None) -> ExtractResult:
    encryption = _detect_encryption(archive)
    log.info("%s 암호화 방식: %s", archive.name, encryption)

    if encryption != "none" and not password:
        raise ZipUnlockError(
            f"{archive.name} 은 암호가 걸려 있는데 비밀번호가 설정되지 않았습니다. "
            ".env 의 BANKSALAD_ZIP_PASSWORD 를 채우세요."
        )

    dest_dir.mkdir(parents=True, exist_ok=True)
    pwd = password.encode("utf-8") if password else None

    # pyzipper.AESZipFile 은 zipfile 의 상위 호환 — AES 와 ZipCrypto 를 모두 읽는다.
    extracted: list[Path] = []
    try:
        with pyzipper.AESZipFile(archive) as zf:
            if pwd:
                zf.setpassword(pwd)
            for info in zf.infolist():
                if info.is_dir():
                    continue
                name = _decode_name(info)
                if not _is_safe_member(name):
                    log.warning("위험한 경로라 건너뜀: %s", name)
                    continue
                target = dest_dir / Path(name).name
                target.write_bytes(zf.read(info))
                target.chmod(0o600)
                extracted.append(target)
    except RuntimeError as exc:
        # pyzipper 는 비밀번호가 틀리면 RuntimeError("Bad password for file ...") 를 던진다.
        if "password" in str(exc).lower():
            raise ZipUnlockError(f"{archive.name} 비밀번호가 틀렸습니다.") from exc
        raise ZipUnlockError(f"{archive.name} 해제 실패: {exc}") from exc

    if not extracted:
        raise ZipUnlockError(f"{archive.name} 안에 추출할 파일이 없습니다.")

    log.info("%d개 파일 추출 → %s", len(extracted), dest_dir)
    return ExtractResult(
        source=archive, dest_dir=dest_dir, files=extracted, encryption=encryption
    )
