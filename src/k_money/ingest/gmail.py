"""Gmail 에서 첨부파일을 찾아 내려받는다.

읽기 전용 스코프만 요청한다. 메일을 보내거나 지우거나 라벨을 바꾸지 않는다.
"""

from __future__ import annotations

import base64
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

log = logging.getLogger(__name__)

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]


@dataclass(frozen=True)
class Attachment:
    message_id: str
    attachment_id: str
    filename: str
    size_bytes: int
    received_at: datetime
    subject: str


class GmailAuthError(RuntimeError):
    pass


def build_service(client_secret_file: Path, token_file: Path):
    """OAuth 인증 후 Gmail 서비스 객체를 반환한다.

    최초 1회는 브라우저가 열리고 사용자 동의가 필요하다. 이후에는 토큰 캐시를 쓴다.
    """
    creds: Credentials | None = None

    if token_file.exists():
        creds = Credentials.from_authorized_user_file(str(token_file), SCOPES)

    if creds and creds.expired and creds.refresh_token:
        log.info("만료된 토큰 갱신 중")
        creds.refresh(Request())

    if not creds or not creds.valid:
        if not client_secret_file.exists():
            raise GmailAuthError(
                f"OAuth 클라이언트 파일이 없습니다: {client_secret_file}\n"
                "docs/setup-gmail.md 의 1~3단계를 먼저 진행하세요."
            )
        log.info("브라우저에서 Google 계정 동의가 필요합니다")
        flow = InstalledAppFlow.from_client_secrets_file(str(client_secret_file), SCOPES)
        creds = flow.run_local_server(port=0)

    token_file.parent.mkdir(parents=True, exist_ok=True)
    token_file.write_text(creds.to_json())
    token_file.chmod(0o600)

    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def _walk_parts(part: dict):
    """MIME 트리를 재귀적으로 순회한다. 중첩 multipart 안의 첨부도 잡기 위함."""
    yield part
    for child in part.get("parts") or []:
        yield from _walk_parts(child)


def _header(payload: dict, name: str) -> str:
    for h in payload.get("headers") or []:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def find_attachments(
    service,
    query: str,
    *,
    suffix: str = ".zip",
    max_messages: int = 20,
) -> list[Attachment]:
    """쿼리에 매칭되는 메일에서 지정 확장자의 첨부 목록을 최신순으로 반환한다."""
    resp = (
        service.users()
        .messages()
        .list(userId="me", q=query, maxResults=max_messages)
        .execute()
    )
    messages = resp.get("messages") or []
    log.info("쿼리 매칭 메일 %d건", len(messages))

    found: list[Attachment] = []
    for ref in messages:
        msg = service.users().messages().get(userId="me", id=ref["id"], format="full").execute()
        payload = msg.get("payload") or {}
        subject = _header(payload, "Subject")
        received_at = datetime.fromtimestamp(int(msg["internalDate"]) / 1000, tz=timezone.utc)

        for part in _walk_parts(payload):
            filename = part.get("filename") or ""
            body = part.get("body") or {}
            attachment_id = body.get("attachmentId")
            if not filename or not attachment_id:
                continue
            if suffix and not filename.lower().endswith(suffix.lower()):
                continue
            found.append(
                Attachment(
                    message_id=ref["id"],
                    attachment_id=attachment_id,
                    filename=filename,
                    size_bytes=int(body.get("size") or 0),
                    received_at=received_at,
                    subject=subject,
                )
            )

    found.sort(key=lambda a: a.received_at, reverse=True)
    return found


def download(service, attachment: Attachment, dest_dir: Path) -> Path:
    """첨부를 dest_dir 에 저장하고 경로를 반환한다."""
    data = (
        service.users()
        .messages()
        .attachments()
        .get(userId="me", messageId=attachment.message_id, id=attachment.attachment_id)
        .execute()
    )
    raw = base64.urlsafe_b64decode(data["data"])

    dest_dir.mkdir(parents=True, exist_ok=True)
    # 파일명은 메일에서 온 값 — 경로 조작을 막기 위해 basename 만 쓴다.
    safe_name = Path(attachment.filename).name
    stamp = attachment.received_at.strftime("%Y%m%d")
    dest = dest_dir / f"{stamp}_{safe_name}"
    dest.write_bytes(raw)
    dest.chmod(0o600)
    log.info("저장: %s (%d bytes)", dest, len(raw))
    return dest
