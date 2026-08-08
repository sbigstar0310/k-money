/**
 * k-money — ZipCrypto 복호화 (Apps Script V8)
 *
 * 왜 직접 구현하는가:
 *   · Utilities.unzip() 은 암호 걸린 zip 을 못 푼다
 *   · UnzipGs(zlib.js) 는 V8 을 꺼야 하는데 Rhino 는 2026-01-31 sunset 됐다
 *   · 뱅샐 zip 은 ZipCrypto(traditional PKWARE) 다 — 내보내기 2건 실측 확인
 *
 * 전략:
 *   ZipCrypto 만 직접 풀고(스트림 암호, 40줄), 복호화된 deflate 스트림으로
 *   **암호 없는 zip 을 재조립**해 Utilities.unzip() 에 넘긴다.
 *   inflate 가 네이티브라 순수 JS 구현보다 자릿수 단위로 빠르다.
 *
 * 알고리즘은 Python 으로 먼저 구현해 표준 zipfile 결과와
 * 바이트 단위 일치를 확인한 뒤 이식했다 (121,210 bytes, CRC 374C3F06).
 */

// ── CRC32 (ZipCrypto 키 갱신용) ────────────────────────────────────

var CRC_TABLE = (function () {
  var t = new Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i;
    for (var j = 0; j < 8; j++) c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32Byte_(crc, b) {
  return ((crc >>> 8) ^ CRC_TABLE[(crc ^ b) & 0xFF]) >>> 0;
}

// ── ZipCrypto 키 스트림 ────────────────────────────────────────────

function ZipCryptoKeys_(password) {
  this.k0 = 0x12345678;
  this.k1 = 0x23456789;
  this.k2 = 0x34567890;
  var pw = Utilities.newBlob(password).getBytes();
  for (var i = 0; i < pw.length; i++) this.update(pw[i] & 0xFF);
}

ZipCryptoKeys_.prototype.update = function (b) {
  this.k0 = crc32Byte_(this.k0, b);
  // (k1 + (k0 & 0xff)) * 134775813 + 1 — 32비트를 넘으므로 Math.imul 필수
  this.k1 = (Math.imul((this.k1 + (this.k0 & 0xFF)) >>> 0, 134775813) + 1) >>> 0;
  this.k2 = crc32Byte_(this.k2, (this.k1 >>> 24) & 0xFF);
};

ZipCryptoKeys_.prototype.streamByte = function () {
  var t = (this.k2 | 2) & 0xFFFF;
  return ((t * (t ^ 1)) >>> 8) & 0xFF;
};

/** 암호문 구간을 제자리에서 복호화한다. bytes 는 부호 있는 배열(Apps Script 관례). */
ZipCryptoKeys_.prototype.decrypt = function (bytes, from, to) {
  for (var i = from; i < to; i++) {
    var p = ((bytes[i] & 0xFF) ^ this.streamByte()) & 0xFF;
    this.update(p);
    bytes[i] = (p << 24) >> 24; // 다시 부호 있는 바이트로
  }
};

// ── 바이트 유틸 ────────────────────────────────────────────────────

function u16_(b, o) { return (b[o] & 0xFF) | ((b[o + 1] & 0xFF) << 8); }
function u32_(b, o) {
  return ((b[o] & 0xFF) | ((b[o + 1] & 0xFF) << 8) |
          ((b[o + 2] & 0xFF) << 16) | ((b[o + 3] & 0xFF) << 24)) >>> 0;
}
function put16_(a, v) { a.push((v & 0xFF) << 24 >> 24, ((v >>> 8) & 0xFF) << 24 >> 24); }
function put32_(a, v) {
  a.push((v & 0xFF) << 24 >> 24, ((v >>> 8) & 0xFF) << 24 >> 24,
         ((v >>> 16) & 0xFF) << 24 >> 24, ((v >>> 24) & 0xFF) << 24 >> 24);
}

// ── 메인 ───────────────────────────────────────────────────────────

/**
 * 암호 걸린 zip Blob 을 풀어 내부 파일 Blob 배열을 반환한다.
 * @param {Blob} zipBlob 암호 zip
 * @param {string} password 비밀번호
 * @return {Blob[]}
 */
function unzipEncrypted(zipBlob, password) {
  var b = zipBlob.getBytes();

  // 1) EOCD 를 뒤에서 찾는다 (주석이 있을 수 있어 역방향 탐색)
  var eocd = -1;
  for (var i = b.length - 22; i >= 0 && i > b.length - 65558; i--) {
    if (u32_(b, i) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 형식이 아니다 (EOCD 없음)');

  var entryCount = u16_(b, eocd + 10);
  var cdOffset = u32_(b, eocd + 16);

  var results = [];
  var p = cdOffset;

  for (var n = 0; n < entryCount; n++) {
    if (u32_(b, p) !== 0x02014B50) throw new Error('중앙 디렉토리 손상 (엔트리 ' + n + ')');

    var flags     = u16_(b, p + 8);
    var method    = u16_(b, p + 10);
    var modTime   = u16_(b, p + 12);
    var modDate   = u16_(b, p + 14);
    var crc       = u32_(b, p + 16);
    var compSize  = u32_(b, p + 20);
    var rawSize   = u32_(b, p + 24);
    var nameLen   = u16_(b, p + 28);
    var extraLen  = u16_(b, p + 30);
    var cmtLen    = u16_(b, p + 32);
    var localOff  = u32_(b, p + 42);
    var nameBytes = b.slice(p + 46, p + 46 + nameLen);

    p += 46 + nameLen + extraLen + cmtLen;

    var isDir = nameLen > 0 && (nameBytes[nameLen - 1] & 0xFF) === 0x2F; // '/'
    if (isDir) continue;

    // 2) 로컬 헤더에서 실제 데이터 시작 위치 계산 (extra 길이가 다를 수 있다)
    if (u32_(b, localOff) !== 0x04034B50) throw new Error('로컬 헤더 손상');
    var lNameLen = u16_(b, localOff + 26);
    var lExtraLen = u16_(b, localOff + 28);
    var dataStart = localOff + 30 + lNameLen + lExtraLen;

    var encrypted = (flags & 0x1) !== 0;
    var payload, payloadSize;

    if (encrypted) {
      if (method === 99) {
        throw new Error('AES(WinZip) 암호화는 지원하지 않는다. 뱅샐은 ZipCrypto 여야 한다.');
      }
      var keys = new ZipCryptoKeys_(password);
      // 앞 12바이트는 암호화 헤더 — 복호화 후 마지막 바이트로 비번을 검증한다
      keys.decrypt(b, dataStart, dataStart + 12);
      var checkByte = b[dataStart + 11] & 0xFF;
      // 데이터 디스크립터(bit 3)를 쓰면 modTime 상위 바이트, 아니면 CRC 최상위 바이트
      var expected = (flags & 0x8) ? ((modTime >>> 8) & 0xFF) : ((crc >>> 24) & 0xFF);
      if (checkByte !== expected) {
        throw new Error('비밀번호가 틀렸다 (검증바이트 0x' + checkByte.toString(16) +
                        ', 기대 0x' + expected.toString(16) + ')');
      }
      keys.decrypt(b, dataStart + 12, dataStart + compSize);
      payload = b.slice(dataStart + 12, dataStart + compSize);
      payloadSize = compSize - 12;
    } else {
      payload = b.slice(dataStart, dataStart + compSize);
      payloadSize = compSize;
    }

    // 3) 암호 없는 zip 으로 재조립 → Utilities.unzip 이 네이티브로 inflate
    //    플래그는 0x800(UTF-8 파일명)만 세운다. 뱅샐 zip 은 UTF-8 바이트를
    //    쓰면서 이 비트를 안 세워 한글 파일명이 CP437 로 오독된다 — 여기서 고쳐진다.
    var out = [];
    put32_(out, 0x04034B50); put16_(out, 20); put16_(out, 0x800);
    put16_(out, method); put16_(out, modTime); put16_(out, modDate);
    put32_(out, crc); put32_(out, payloadSize); put32_(out, rawSize);
    put16_(out, nameLen); put16_(out, 0);
    out = out.concat(nameBytes, payload);

    var cdStart = out.length;
    put32_(out, 0x02014B50); put16_(out, 20); put16_(out, 20); put16_(out, 0x800);
    put16_(out, method); put16_(out, modTime); put16_(out, modDate);
    put32_(out, crc); put32_(out, payloadSize); put32_(out, rawSize);
    put16_(out, nameLen); put16_(out, 0); put16_(out, 0);
    put16_(out, 0); put16_(out, 0); put32_(out, 0); put32_(out, 0);
    out = out.concat(nameBytes);

    var cdSize = out.length - cdStart;
    put32_(out, 0x06054B50); put16_(out, 0); put16_(out, 0);
    put16_(out, 1); put16_(out, 1);
    put32_(out, cdSize); put32_(out, cdStart); put16_(out, 0);

    var plain = Utilities.newBlob(out, 'application/zip', 'plain.zip');
    var files = Utilities.unzip(plain);
    for (var f = 0; f < files.length; f++) results.push(files[f]);
  }

  if (results.length === 0) throw new Error('추출할 파일이 없다');
  return results;
}


// ── 검증 ───────────────────────────────────────────────────────────

/**
 * STEP 4 — 실제 뱅샐 zip 을 푼다. step2 가 Drive 에 올려둔 파일을 쓴다.
 * 실행 전에 아래 PASSWORD 를 뱅샐에서 설정한 값으로 바꿔라.
 */
function step4_decrypt() {
  var PASSWORD = '0930';

  Logger.log('=== STEP 4: ZipCrypto 해제 ===');

  var folders = DriveApp.getFoldersByName('k-money');
  if (!folders.hasNext()) { Logger.log('❌ k-money 폴더 없음. step2 를 먼저 실행하라.'); return; }
  var folder = folders.next();

  var zipFile = null;
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.getName().toLowerCase().indexOf('.zip') !== -1) { zipFile = f; break; }
  }
  if (!zipFile) { Logger.log('❌ zip 파일 없음. step2 를 먼저 실행하라.'); return; }

  Logger.log('대상: ' + zipFile.getName() + ' (' + zipFile.getSize() + ' bytes)');

  var t0 = new Date().getTime();
  var files;
  try {
    files = unzipEncrypted(zipFile.getBlob(), PASSWORD);
  } catch (e) {
    Logger.log('❌ 실패: ' + e.message);
    return;
  }
  var ms = new Date().getTime() - t0;

  Logger.log('✅ 해제 성공 — ' + files.length + '개 파일, ' + ms + 'ms');
  for (var i = 0; i < files.length; i++) {
    Logger.log('   ' + files[i].getName() + '  (' + files[i].getBytes().length + ' bytes)');
  }

  // xlsx 를 Google Sheets 로 변환 — openpyxl 이식이 통째로 사라지는 지점
  var xlsx = null;
  for (var j = 0; j < files.length; j++) {
    if (files[j].getName().toLowerCase().indexOf('.xlsx') !== -1) { xlsx = files[j]; break; }
  }
  if (!xlsx) { Logger.log('⚠️ xlsx 를 못 찾음'); return; }

  try {
    var converted = Drive.Files.create(
      { name: 'k-money-parsed', mimeType: MimeType.GOOGLE_SHEETS, parents: [folder.getId()] },
      xlsx
    );
    var ss = SpreadsheetApp.openById(converted.id);
    var names = ss.getSheets().map(function (s) { return s.getName(); });
    Logger.log('✅ Google Sheets 변환 성공 — 시트: ' + names.join(', '));

    var ledger = ss.getSheetByName('가계부 내역');
    if (ledger) {
      Logger.log('   가계부 내역: ' + ledger.getLastRow() + '행 × ' + ledger.getLastColumn() + '열');
      Logger.log('   헤더: ' + ledger.getRange(1, 1, 1, ledger.getLastColumn()).getValues()[0].join(' | '));
    }
    Logger.log('   URL: ' + ss.getUrl());
  } catch (e) {
    Logger.log('⚠️ Sheets 변환 실패: ' + e.message);
    Logger.log('   → 서비스 메뉴에서 Drive API(고급 서비스)를 켜야 한다.');
  }
}
