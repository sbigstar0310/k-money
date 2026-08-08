/**
 * core 모듈의 **의존 순서**. 여기서만 정한다.
 *
 * ⚠️ 이건 취향이 아니라 지식이다. Apps Script 는 프로젝트 안 파일들의
 *    전역 실행 순서를 보장하지 않고, 각 모듈은 로드 시점에
 *    `var M = KM.model` 로 참조를 잡는다. layout 이 model 보다 먼저 돌면
 *    M 이 영원히 undefined 가 되는데 **프로그램은 안 죽고 이상한 값을 낸다.**
 *
 *    이 배열이 세 군데(빌드·로컬 실행·테스트)에 복사돼 있었다. 새 모듈을
 *    추가하면서 한 군데를 잊으면 테스트가 프로덕션과 다른 그래프를 로드한다.
 */

'use strict';

module.exports = ['model', 'layout', 'analyze', 'parse', 'aggregate'];
