"""money-audit CLI — 인제스트 파이프라인 검증용."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from money_audit.config import load_config
from money_audit.ingest import probe, unpack
from money_audit.ingest import pipeline as ingest_pipeline


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(levelname)-7s %(message)s",
    )


def cmd_ingest(args: argparse.Namespace) -> int:
    config = load_config()
    result = ingest_pipeline.run(config, dry_run=args.dry_run)
    if result is None:
        return 1

    print()
    print(f"메일       : {result.attachment.subject}")
    print(f"수신       : {result.attachment.received_at.astimezone()}")
    print(f"아카이브   : {result.archive}")
    print(f"암호화     : {result.extraction.encryption}")
    print(f"추출 파일  : {len(result.extraction.files)}개")
    print()
    print(probe.to_json(result.shapes))
    return 0


def cmd_unpack(args: argparse.Namespace) -> int:
    """이미 손에 있는 zip 으로 해제 + 구조 파악만 검증한다 (Gmail 없이)."""
    config = load_config()
    password = args.password or config.zip_password
    result = unpack.extract(Path(args.archive), config.extract_dir, password)

    print(f"암호화    : {result.encryption}")
    print(f"추출 파일 : {len(result.files)}개 → {result.dest_dir}")
    print()
    print(probe.to_json(probe.probe_all(result.files)))
    return 0


def cmd_probe(args: argparse.Namespace) -> int:
    paths = [Path(p) for p in args.paths]
    print(probe.to_json(probe.probe_all(paths)))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="money-audit")
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    p_ingest = sub.add_parser("ingest", help="Gmail 에서 최신 zip 을 받아 해제하고 구조를 찍는다")
    p_ingest.add_argument("--dry-run", action="store_true", help="후보만 보고 다운로드하지 않음")
    p_ingest.set_defaults(func=cmd_ingest)

    p_unpack = sub.add_parser("unpack", help="로컬 zip 을 해제하고 구조를 찍는다")
    p_unpack.add_argument("archive")
    p_unpack.add_argument("--password", help="미지정 시 .env 의 BANKSALAD_ZIP_PASSWORD 사용")
    p_unpack.set_defaults(func=cmd_unpack)

    p_probe = sub.add_parser("probe", help="엑셀/CSV 파일의 시트·헤더·샘플 행을 찍는다")
    p_probe.add_argument("paths", nargs="+")
    p_probe.set_defaults(func=cmd_probe)

    args = parser.parse_args(argv)
    _setup_logging(args.verbose)

    try:
        return args.func(args)
    except Exception as exc:  # noqa: BLE001 - CLI 최상단에서 사용자에게 원인을 보여준다
        logging.error("%s: %s", type(exc).__name__, exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
