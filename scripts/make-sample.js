#!/usr/bin/env node
/**
 * docs/sample-latest.json 을 만든다.
 *
 * **설치 전에 "뭘 넘기게 되는지" 보여주는 유일한 파일이다.** 그래서 손으로
 * 만들지 않고 진짜 파이프라인을 통과시킨다 — 스키마가 바뀌면 여기도 같이
 * 바뀌어야 하고, 손으로 만들면 반드시 어긋난다.
 *
 * ⚠️ 숫자는 전부 지어낸 것이다. 실데이터는 절대 넣지 마라.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const H = require('../test/lib/helpers');

const KM = H.loadCore();
const txns = [];

const daily = [
  ['식비', '한식', '김밥천국', 9500], ['식비', '카페', '스타벅스', 5500],
  ['식비', '배달', '배달의민족', 18000], ['교통', '대중교통', '지하철', 1550],
  ['생활', '편의점', 'GS25', 6800], ['식비', '회식', '고깃집', 32000],
  ['쇼핑', '의류', '무신사', 48000], ['생활', '생필품', '다이소', 12000],
  ['식비', '점심', '백반집', 11000], ['문화/여가', '영화', 'CGV', 15000],
  ['교통', '택시', '카카오T', 9800], ['식비', '술집', '포차', 27000],
];
const fixed = [
  ['주거/통신', '월세', '월세', 620000, 1], ['주거/통신', '통신', 'SKT', 55000, 17],
  ['문화/여가', '구독', '넷플릭스', 13500, 15], ['문화/여가', '구독', '유튜브 프리미엄', 14900, 5],
  ['금융', '보험', '실손보험', 32000, 25], ['건강', '운동', '헬스장', 69000, 3],
];

function month(y, m, income) {
  const mm = String(m).padStart(2, '0');
  txns.push(H.income(`${y}-${mm}-25`, income, { major: '급여', minor: '월급', desc: '(주)회사' }));
  fixed.forEach((f) => txns.push(
    H.expense(`${y}-${mm}-${String(f[4]).padStart(2, '0')}`, f[3],
      { major: f[0], minor: f[1], desc: f[2] })));
  for (let d = 2; d <= 28; d++) {
    const c = daily[(d * 7 + m) % daily.length];
    txns.push(H.expense(`${y}-${mm}-${String(d).padStart(2, '0')}`, c[3],
      { major: c[0], minor: c[1], desc: c[2] }));
  }
}

for (let m = 7; m <= 12; m++) month(2025, m, 2450000);
for (let m = 1; m <= 6; m++) month(2026, m, 2600000);

txns.push(H.expense('2026-04-18', 1890000, { major: '쇼핑', minor: '가전', desc: '노트북' }));
txns.push(H.expense('2026-02-14', 450000, { major: '여행', minor: '항공', desc: '제주항공' }));
txns.push(H.transfer('2026-03-10', -300000, '홍길동'));
txns.push(H.income('2026-05-20', 800000, { major: '기타', minor: '상여', desc: '(주)회사' }));

const status = {
  owner: '홍길동', age: 27,
  assets: [
    { group: '자유입출금 자산', name: '주거래통장', amount: 2840000 },
    { group: '저축성 자산', name: '청년희망적금', amount: 7200000 },
    { group: '투자성 자산', name: '연금저축펀드', amount: 3150000 },
  ],
  debts: [{ group: '신용대출', name: '학자금대출', amount: 11400000 }],
  investments: [
    { kind: '펀드', broker: '미래에셋', name: 'TDF2050', principal: 3000000, value: 3150000 },
  ],
};

const facts = KM.aggregate.build(KM.parse.extract(H.sheets(txns, status)), { asOf: '2026-06-30' });
facts.generatedAt = '2026-06-30T22:00:00.000Z';
facts.sourceMessageId = 'sample';   // 테스트가 이걸로 실데이터 커밋을 막는다

const out = path.join(__dirname, '..', 'docs', 'sample-latest.json');
fs.writeFileSync(out, JSON.stringify(facts, null, 2) + '\n');
console.log('docs/sample-latest.json — ' + JSON.stringify(facts).length + ' bytes');
