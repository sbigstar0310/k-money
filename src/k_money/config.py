"""환경 설정 로딩. 시크릿은 .env 에서만 읽고, 로그에 찍지 않는다."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

DEFAULT_GMAIL_QUERY = "has:attachment filename:zip (뱅크샐러드 OR banksalad)"


@dataclass(frozen=True)
class Config:
    client_secret_file: Path
    token_file: Path
    zip_password: str | None
    gmail_query: str
    data_dir: Path

    @property
    def download_dir(self) -> Path:
        return self.data_dir / "raw"

    @property
    def extract_dir(self) -> Path:
        return self.data_dir / "extracted"


def load_config(project_root: Path | None = None) -> Config:
    root = project_root or Path.cwd()
    load_dotenv(root / ".env")

    def _path(key: str, default: str) -> Path:
        raw = os.environ.get(key) or default
        p = Path(raw).expanduser()
        return p if p.is_absolute() else (root / p).resolve()

    password = os.environ.get("BANKSALAD_ZIP_PASSWORD") or None

    return Config(
        client_secret_file=_path("GOOGLE_CLIENT_SECRET_FILE", "./secrets/client_secret.json"),
        token_file=_path("GOOGLE_TOKEN_FILE", "./secrets/gmail_token.json"),
        zip_password=password,
        gmail_query=os.environ.get("BANKSALAD_GMAIL_QUERY") or DEFAULT_GMAIL_QUERY,
        data_dir=_path("MONEY_AUDIT_DATA_DIR", "./data"),
    )
