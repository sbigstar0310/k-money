"""메일 → zip → 해제 → 구조 파악까지 한 번에 도는 파이프라인.

이 파이프라인이 자동으로 도는지가 프로젝트의 핵심 가설이다.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from money_audit.config import Config
from money_audit.ingest import gmail, probe, unpack

log = logging.getLogger(__name__)


@dataclass
class IngestResult:
    attachment: gmail.Attachment
    archive: Path
    extraction: unpack.ExtractResult
    shapes: list[probe.FileShape]


def run(config: Config, *, dry_run: bool = False) -> IngestResult | None:
    service = gmail.build_service(config.client_secret_file, config.token_file)

    attachments = gmail.find_attachments(service, config.gmail_query)
    if not attachments:
        log.error("쿼리에 매칭되는 첨부를 찾지 못했습니다: %s", config.gmail_query)
        return None

    for a in attachments[:5]:
        log.info(
            "후보: %s | %s | %s | %.1f KB",
            a.received_at.date(),
            a.subject[:40],
            a.filename,
            a.size_bytes / 1024,
        )

    latest = attachments[0]
    if dry_run:
        log.info("dry-run — 다운로드하지 않고 종료합니다.")
        return None

    archive = gmail.download(service, latest, config.download_dir)
    extraction = unpack.extract(archive, config.extract_dir, config.zip_password)
    shapes = probe.probe_all(extraction.files)

    return IngestResult(
        attachment=latest, archive=archive, extraction=extraction, shapes=shapes
    )
