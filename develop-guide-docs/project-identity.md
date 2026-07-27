# ZZ 프로젝트 정체성

> **문서 상태: 현재 · 권위 있는 제품 방향**

이 문서는 ZZ가 무엇인지, 왜 OMP를 fork했는지, 무엇을 제품의 핵심으로 유지하고 무엇을 하지
않는지를 정의한다. 기능을 추가할 때 구현 가능 여부만 보지 말고 이 정체성과 일치하는지 먼저
판단한다.

## 1. 한 문장 정의

ZZ는 강력한 범용 코딩 에이전트인 OMP를 기반으로, **장기 작업을 설명 가능하고 복구 가능한
제어 흐름으로 실행하며 검증된 지식만 의도적으로 재사용하도록 만든 로컬 우선 터미널 코딩
에이전트**다.

ZZ의 목표는 모델을 단순히 더 자율적으로 만드는 것이 아니다. 사용자가 긴 작업을 맡겼을 때
모델의 추론 능력은 최대한 활용하되, 현재 상태·권한·증거·과거 지식을 서로 다른 계층에서
관리해 작업을 신뢰할 수 있게 만드는 것이다.

## 2. 출발점과 fork 관계

- upstream: `can1357/oh-my-pi`
- ZZ fork: `Fred-Ko/zz`
- 공개 제품명과 실행 파일: `ZZ`, `zz`
- 기본 사용자 설정 루트: `~/.zz`
- 프로젝트 로컬 에이전트 자산: `.zz/`
- 기본 개발 대상: `packages/coding-agent/`

ZZ는 OMP의 모델 공급자, tool calling, TUI, LSP, skill, extension, 세션, 협업 기능을 기반으로
계속 upstream과 호환 가능한 fork로 발전한다. 따라서 공개 UX는 ZZ로 리브랜딩하되,
`@oh-my-pi/*`, `__omp_worker_*`, wire 필드와 일부 legacy 환경 변수처럼 호환성 비용이 큰 내부
식별자는 근거 없이 바꾸지 않는다.

## 3. ZZ가 해결하려는 문제

일반적인 코딩 에이전트는 한 세션 안에서는 뛰어나지만 긴 작업에서는 다음 문제가 드러난다.

1. 대화에 적힌 목표와 실제 workspace 상태가 쉽게 어긋난다.
2. 계획이 바뀐 이유와 완료 판단 근거가 자유 텍스트에 묻힌다.
3. 명령이 중간에 끊기면 적용 여부를 모른 채 재실행할 수 있다.
4. 테스트 한 번의 성공이나 tool 성공을 전체 Task 성공으로 오해할 수 있다.
5. 과거 세션을 모두 기억에 넣으면 비용과 노이즈가 커지고 오래된 사실이 현재 상태를 오염시킨다.
6. 모든 작업에 강한 통제를 적용하면 짧은 질문과 원본 Goal의 자연스러운 사용성까지 망가진다.

ZZ는 이 문제를 하나의 거대한 프롬프트로 해결하지 않는다. 일반 대화, 원본 Goal,
ZZWorkflow, ZZ Knowledge를 서로 다른 제품 계층으로 분리한다.

## 4. 제품의 네 계층

| 계층          | 사용자 경험                                   | 책임                                                     |
| ------------- | --------------------------------------------- | -------------------------------------------------------- |
| 일반 에이전트 | 질문하고 바로 수정·조사                       | OMP 기반의 범용 코딩 작업                                |
| 원본 Goal     | `/goal`, `/guided-goal`                       | 세션 중심의 지속 자율 목표; upstream 경험 보존           |
| ZZWorkflow    | `/zzw-goal`, `/zzw-guided-goal`, `/zzw`       | Task Contract, Plan DAG, 승인, operation, evidence, 복구 |
| ZZ Knowledge  | 자연어 기억 요청, `knowledge_*`, `/knowledge` | 범위·근거·수명을 가진 장기 지식의 retain/recall/curation |

ZZWorkflow와 ZZ Knowledge는 함께 사용할 수 있지만 같은 시스템이 아니다. ZZW는 현재 Task의
권위 있는 실행 상태를 관리하고, Knowledge는 미래 의사결정에 유용한 과거 지식을 보조한다.
Knowledge를 꺼도 ZZW가 동작해야 하며, ZZW Task가 없어도 명시적인 Knowledge 요청은 처리할 수
있어야 한다.

## 5. 제품 원칙

### 5.1 모델의 능력과 runtime의 권한을 분리한다

모델은 조사하고, 판단하고, 계획하고, 수정안을 제안한다. 하지만 자신의 계약이나 위험 확대를
스스로 승인하지 않는다. 권한과 상태 전이는 구조화된 tool과 runtime이 검사한다.

### 5.2 현재 사실과 과거 지식을 분리한다

현재 HEAD, diff, active step, operation, 최신 테스트 결과는 Git·SQLite Registry·Evidence가
소유한다. Hindsight가 기억한 과거 결정과 경험은 advisory evidence이며 현재 사실을 덮어쓰지
못한다.

### 5.3 계획은 고정된 체크리스트가 아니라 진화하는 DAG다

처음 세운 Plan은 구현 중 얻은 증거로 분해·확장·교체될 수 있다. 정상적인 구현 피드백은 같은
단계 안에서 처리하고, 목표·권한·검증 계약이 실제로 바뀔 때만 Plan을 변경한다. 과거 노드는
삭제하지 않고 lineage로 남긴다.

### 5.4 승인은 방해물이 아니라 권한 경계다

초기 실행 계약과 material change는 사용자가 승인한다. 승인 범위 안에서 생긴 컴파일 오류,
테스트 피드백, 로컬 인프라 준비는 매번 새 승인을 요구하지 않는다. 승인 빈도를 높이는 것 자체가
안전성이 아니다.

### 5.5 로컬 우선을 기본값으로 한다

ZZWorkflow는 별도 daemon이나 중앙 coordinator 없이 `zz` 프로세스 안에 내장되고 저장소별
`bun:sqlite` DB를 사용한다. Git과 로컬 workspace가 작업 복구의 중심이다. 네트워크 서비스인
Hindsight는 Knowledge 의미 저장소로만 선택적으로 사용하며, 장애가 나도 로컬 outbox가 요청을
보존한다.

### 5.6 기억은 자동 수집이 아니라 의도적 지식 관리다

대화 전체, raw 로그, 현재 진행률을 장기 기억으로 자동 저장하지 않는다. 미래 용도, scope,
authority, source evidence가 있는 durable knowledge만 저장한다. 사용자 명시 요청은 같은 turn에
tool receipt로 처리하고, 하나의 요청에서 나온 항목은 같은 group ID로 관리한다.

### 5.7 사용자가 현재 상태를 이해할 수 있어야 한다

상태줄과 `/zzw`, `/knowledge` 명령은 모델의 서술과 독립적으로 실제 상태를 보여 준다. 승인 대기,
실행, 검증, 복구, 중단의 이유와 다음 동작이 화면에서 드러나야 한다. 특별한 요청이 없으면
사용자 대화와 제품 기본 메시지는 한국어로 제공한다.

## 6. 명시적인 비목표

현재 ZZ는 다음을 목표로 하지 않는다.

- 여러 머신의 workspace를 하나의 중앙 coordinator로 자동 동기화
- Git을 대체하는 파일 버전 관리 시스템
- 모든 대화에 강제되는 enterprise workflow engine
- 모델이 계약·Plan·위험 작업·완료를 스스로 승인하는 완전 무감독 실행
- 모든 세션 transcript와 tool log를 Hindsight에 자동 보존
- upstream 내부 식별자를 사용자-facing 이름과 함께 무조건 일괄 rename
- 사용자의 명시적 동의 없는 자동 QA·불만·telemetry 보고
- PostgreSQL이나 외부 RDBMS를 ZZ의 로컬 상태 저장소로 운영

이 비목표를 바꾸려면 단순 구현 변경이 아니라 [architecture-decisions.md](architecture-decisions.md)에
새 결정과 migration·호환·privacy 영향을 기록해야 한다.

## 7. 이름과 용어

| 이름         | 의미                                             |
| ------------ | ------------------------------------------------ |
| ZZ           | 전체 제품과 fork의 공개 이름                     |
| `zz`         | 사용자-facing CLI 실행 파일                      |
| ZZWorkflow   | 제어형 Task 실행 계층의 정식 이름                |
| ZZW          | ZZWorkflow의 UI·명령어 약어                      |
| ZZ Knowledge | OMP Memory와 독립된 장기 지식 정책 계층          |
| Hindsight    | ZZ Knowledge가 감싼 외부 의미 기억 공급자        |
| Registry     | 현재 ZZW 상태를 저장하는 저장소별 SQLite         |
| Evidence     | workspace snapshot과 연결된 실행·검증 근거       |
| Plan DAG     | dependency, validation, lineage를 가진 실행 계획 |

`komp`, `workflowd`, `zz-workflowd`, coordinator, OMP Memory는 현재 제품 이름이나 활성
아키텍처가 아니다. 역사적 맥락은 [initial-concept-archive.md](initial-concept-archive.md)에만
보존한다.

## 8. 기능 수용 판단 기준

새 기능은 다음 질문에 답할 수 있어야 한다.

1. 일반 OMP 기능, ZZW, Knowledge 중 어느 계층의 책임인가?
2. 현재 사실인가, 과거 지식인가, 단순 UI projection인가?
3. 모델의 판단으로 충분한가, 구조화된 tool이 필요한가, runtime 강제가 필요한가?
4. 기존 Goal과 일반 대화의 자연스러운 흐름을 침범하지 않는가?
5. 네트워크가 끊겨도 로컬 상태와 사용자 작업을 잃지 않는가?
6. 사용자가 상태와 권한 변화를 직접 확인할 수 있는가?
7. upstream을 다시 합칠 때 호환 비용이 정당한가?
8. 실제 외부 계약을 검증하는 테스트를 만들 수 있는가?

이 질문에 명확히 답할 수 없다면 코드를 추가하기 전에 먼저 설계 경계를 정리한다.
