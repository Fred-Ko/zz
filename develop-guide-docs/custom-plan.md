# 보관된 초기 설계안

> 이 문서는 구현 전 논의를 보존한 참고 자료이며 현재 구조의 권위 있는 명세가 아니다.
> 별도 `workflowd`, 멀티머신 조정, upstream OMP Memory/Mnemopi/autolearn 위에
> 구축하는 내용은 폐기됐다. 현재 구현은
> [controlled-workflow.md](controlled-workflow.md)와
> [knowledge-system.md](knowledge-system.md)를 따른다.

맞다. Codex·Claude Code형 에이전틱 코딩은 **하나의 실행 루프**가 아니라, 여러 종류의 대화와 작업 상태가 이어지는 **수명주기**로 모델링해야 한다.

사용자는 처음부터 “이 목표를 이 방식으로 구현하라”고 완성된 명세를 주지 않는다. 보통 다음이 섞여 있다.

* 문제를 설명하고 방향을 탐색하는 대화
* 코드베이스에 대한 질문
* 요구사항 인터뷰
* 구현 가능성 조사
* 대안 비교
* 실제 수정 요청
* 작업 중 요구사항 변경
* 일시 중단과 세션 종료
* 며칠 뒤 작업 재개
* 구현 검토와 추가 수정

따라서 올바른 구조는 다음과 같다.

```text
일반 대화
  ↓
작업 후보 식별
  ↓
요구사항 인터뷰
  ↓
저장소·환경 탐색
  ↓
목표·성공 조건 확정
  ↓
작업공간 및 기준 상태 설정
  ↓
계획 생성·검토
  ↓
실행 가능 상태 확인
  ↓
에이전틱 실행 루프
  ↕
질문 / 요구 변경 / 중단 / 복구 / 재계획
  ↓
최종 검증
  ↓
사용자 검토
  ↓
종료·인계·장기 기억 반영
```

Codex는 thread를 ID로 재개하거나 fork할 수 있고, Claude Code도 프로젝트 디렉터리에 연결된 세션을 저장하고 resume 또는 fork할 수 있다. 그러나 이것들은 **대화 이력의 연속성**을 제공할 뿐, 논리적 작업과 실제 작업공간이 여전히 일치한다는 보장은 아니다. ([OpenAI Developers][1])

# 1. 먼저 개념과 ID를 더 세분화해야 한다

앞 답변의 `task/session/workspace`만으로도 부족하다. 연속 실행 구간을 나타내는 `episode`가 추가로 필요하다.

```text
Repository
└─ Task
   ├─ Attempt
   │  ├─ Session
   │  │  ├─ Episode
   │  │  │  ├─ Turn
   │  │  │  └─ Tool Call / Operation
   │  │  └─ Episode
   │  └─ Workspace
   └─ Attempt
      └─ ...
```

| 객체              | 의미                                       |
| --------------- | ---------------------------------------- |
| `repo_id`       | 논리적 저장소                                  |
| `task_id`       | 사용자가 해결하려는 지속적인 목표                       |
| `spec_version`  | 현재 합의된 요구사항 버전                           |
| `attempt_id`    | 특정 해결 전략을 사용하는 시도                        |
| `session_id`    | Codex thread 또는 Claude Code conversation |
| `episode_id`    | 실행 시작·재개부터 중단·종료까지의 연속 활동 구간             |
| `workspace_id`  | 실제 checkout, worktree 또는 sandbox         |
| `plan_version`  | 현재 실행 계획의 버전                             |
| `checkpoint_id` | 검증된 복구 지점                                |
| `operation_id`  | 하나의 쓰기 작업 또는 외부 부작용                      |
| `evidence_id`   | 테스트·로그·diff 등 근거                         |

## 왜 Episode ID가 필요한가

같은 Claude Code session이나 Codex thread를 여러 번 resume할 수 있다.

```text
session-77
├─ episode-1: 요구사항 인터뷰와 조사
├─ episode-2: 구현 시작
├─ episode-3: 크래시 후 복구
└─ episode-4: 사용자 피드백 반영
```

`session_id`만 보면 이 네 구간이 하나로 보인다. 하지만 각 episode마다 다음이 다르다.

* 시작 당시 HEAD
* dirty working tree
* 환경 변수
* 실행 중 프로세스
* 유효한 계획 버전
* 미완료 operation
* 사용 가능한 권한
* 모델과 도구 버전

따라서 복구는 session 단위가 아니라 **episode 경계에서 수행**해야 한다.

# 2. 모든 대화를 작업으로 등록하면 안 된다

에이전트는 처음에는 `CHAT` 또는 `EXPLORATION` 상태에 있어야 한다.

```text
CHAT
├─ 코드 설명
├─ 아이디어 논의
├─ 설계 대안 비교
├─ 오류 메시지 해석
└─ 읽기 전용 코드 조사
```

다음과 같은 조건이 만족될 때만 지속적인 `Task`를 생성한다.

* 사용자가 코드 또는 환경 변경을 요청함
* 여러 단계에 걸쳐 지속해야 하는 목표가 생김
* 중단 후 재개할 가치가 있음
* 검증 가능한 완료 조건이 존재함
* 작업 이력과 변경 상태를 추적할 필요가 있음

즉 하네스에 **Task Commitment Gate**가 필요하다.

```text
사용자 메시지
  ↓
일반 질문인가?
  ├─ 예 → 대화 상태 유지
  └─ 아니오
      ↓
지속 작업인가?
  ├─ 아니오 → 단일 turn 작업
  └─ 예 → task 후보 생성
             ↓
          사용자와 목표 확정
             ↓
          정식 task 생성
```

단순히 “이 코드가 왜 이래?”라고 묻는 순간 task와 worktree를 만드는 것은 과도하다. 반대로 대화 중 사용자가 “좋아, 그 방식으로 실제 수정해줘”라고 말하면 그 시점에 task를 승격해야 한다.

# 3. 전체 수명주기 상태 머신

권장 상태는 다음과 같다.

```text
IDLE
│
├─ CONVERSATION
│  ├─ 질문·답변
│  ├─ 설계 논의
│  └─ 읽기 전용 탐색
│
├─ INTAKE
│  ├─ 작업 후보 등록
│  ├─ 사용자 의도 수집
│  └─ 요구사항 인터뷰
│
├─ DISCOVERY
│  ├─ 저장소 구조 조사
│  ├─ 문제 재현
│  ├─ 관련 코드 탐색
│  └─ 환경 제약 확인
│
├─ SPECIFICATION
│  ├─ 목표
│  ├─ 범위
│  ├─ 제외 범위
│  ├─ 성공 조건
│  └─ 위험·승인 조건 확정
│
├─ PREPARATION
│  ├─ workspace 선택·생성
│  ├─ baseline 기록
│  ├─ 의존성 설치·확인
│  ├─ 초기 테스트
│  └─ plan 작성
│
├─ READY
│  └─ 실행 진입 조건 확인
│
├─ EXECUTING
│  ├─ 관찰
│  ├─ 행동 선택
│  ├─ 실행
│  ├─ 상태 재관찰
│  └─ 국소 검증
│
├─ VERIFYING
│  ├─ 테스트
│  ├─ 회귀 검사
│  ├─ diff 검토
│  └─ 성공 조건 판정
│
├─ REPLANNING
│  ├─ 잘못된 전제 탐지
│  ├─ 영향 범위 계산
│  └─ plan 수정
│
├─ AWAITING_USER
│  ├─ 요구사항 질문
│  ├─ 위험 행동 승인
│  ├─ 대안 선택
│  └─ 결과 검토 요청
│
├─ PAUSING
│  └─ 안전한 중단점 생성
│
├─ SUSPENDED
│  └─ 명시적으로 중단된 작업
│
├─ INTERRUPTED
│  └─ 비정상 종료 또는 연결 유실
│
├─ RECOVERING
│  ├─ 상태 재구성
│  ├─ 미완료 operation 판정
│  └─ plan 유효성 재평가
│
├─ COMPLETING
│  ├─ 최종 정리
│  ├─ 사용자 인계
│  └─ 기억·근거 저장
│
├─ COMPLETED
├─ ABANDONED
└─ FAILED
```

중요한 것은 `EXECUTING`만 반복 루프가 아니라는 점이다. 실제로는 다음과 같은 여러 루프가 존재한다.

```text
인터뷰 루프
탐색 루프
계획 검토 루프
실행 루프
검증 루프
복구 루프
사용자 피드백 루프
```

# 4. 루프 진입 전 단계

## 4.1 Intake: 요구사항 인터뷰

처음부터 모든 요구사항을 확정하려 해서는 안 된다. 사용자의 진술을 다음처럼 분리해야 한다.

```text
confirmed_requirement
provisional_requirement
assumption
open_question
rejected_option
user_preference
out_of_scope
```

예:

```json
{
  "statement": "기존 API 호환성은 유지해야 한다",
  "type": "confirmed_requirement",
  "source_turn_id": "TURN-18",
  "confirmed_at": "2026-07-24T10:05:00+09:00"
}
```

반면 에이전트가 “아마 PostgreSQL만 지원하면 될 것 같다”고 추정한 것은 `assumption`이어야 한다.

Hindsight에는 모든 대화를 그대로 권위 있는 사실로 넣기보다, 다음만 장기 기억으로 승격하는 편이 좋다.

* 사용자가 확인한 요구사항
* 명시적으로 선택한 설계 방향
* 거절한 대안과 이유
* 장기적으로 유용한 저장소 지식

잠정 아이디어와 브레인스토밍을 사실처럼 저장하면 이후 세션에서 오래된 가정이 되살아날 수 있다.

## 4.2 Discovery: 읽기 전용 탐색

실행 루프 전에 별도의 탐색 단계가 필요하다.

```text
저장소 root 확인
AGENTS.md / CLAUDE.md 확인
Git 상태 확인
현재 branch와 HEAD 확인
빌드·테스트 방법 탐색
문제 재현
관련 symbol과 파일 탐색
기존 설계와 테스트 패턴 확인
외부 서비스·환경 의존성 확인
```

Codex에서는 `AGENTS.md`가 행동 지침을 제공하고, memories가 로컬 맥락을 전달하며, skills와 MCP가 반복 절차와 외부 시스템을 연결한다. 공식 문서도 이들을 경쟁 관계가 아닌 보완 관계로 설명한다. ([OpenAI Developers][2])

이 단계에서는 원칙적으로 쓰기 권한을 제한하는 것이 좋다.

```text
Discovery mode:
├─ 파일 읽기 허용
├─ 검색 허용
├─ 안전한 테스트 허용
├─ Git diff 조회 허용
├─ 외부 정보 조회 허용
└─ 코드 수정·삭제·배포 금지
```

## 4.3 Specification: Task Contract 작성

탐색 결과를 바탕으로 task contract를 만든다.

```yaml
task_id: TASK-42
spec_version: 3

goal:
  로그인 세션 갱신 중 발생하는 race condition을 제거한다.

success_conditions:
  - 기존 재현 테스트가 통과한다.
  - 새 동시성 회귀 테스트가 통과한다.
  - 공개 API 동작은 변경하지 않는다.
  - 전체 인증 테스트가 통과한다.

scope:
  - auth/session 모듈
  - 관련 데이터 접근 코드
  - 회귀 테스트

out_of_scope:
  - 인증 시스템 전면 재설계
  - 데이터베이스 교체

constraints:
  - 데이터베이스 migration 금지
  - 외부 API 호환성 유지

approval_required:
  - dependency 추가
  - 공개 API 변경
  - 10개 이상 파일 수정
```

여기서 중요한 것은 요구사항이 변경될 때 기존 task를 덮어쓰지 않고 `spec_version`을 올리는 것이다.

```text
spec-v3
  ↓ 사용자 요구 변경
spec-v4
  ↓
영향받는 plan/artifact/test를 stale 처리
```

## 4.4 Preparation: 초기 상태 설정

실행을 시작하기 전에 baseline을 고정한다.

```json
{
  "workspace_id": "WT-98",
  "repo_id": "REPO-7",
  "branch": "agent/task-42",
  "base_commit": "5bd3c8a",
  "head_commit": "5bd3c8a",
  "dirty_tree_hash": null,
  "dependency_lock_hash": "LOCK-77",
  "environment_hash": "ENV-12",
  "baseline_tests": {
    "command": "pytest tests/auth",
    "passed": 79,
    "failed": 1,
    "evidence_id": "EV-101"
  }
}
```

Codex는 독립 checkout을 제공하는 Git worktree를 지원하고, Claude Code는 세션별 체크포인트와 권한 기능을 제공한다. 그러나 체크포인트와 대화 세션은 Git commit 및 실제 환경 baseline을 대체하지 않으므로, 권위 있는 기준점은 여전히 Git과 별도 상태 저장소로 관리해야 한다. ([OpenAI Developers][3])

## 4.5 Readiness Gate

다음 조건을 만족할 때만 본격적인 실행 루프를 시작한다.

```text
□ task contract가 존재함
□ 사용자의 미해결 필수 질문이 없음
□ repo와 workspace가 식별됨
□ Git baseline이 기록됨
□ 재현 또는 현재 상태가 확인됨
□ 성공 조건이 기계적으로 또는 수동으로 판정 가능함
□ 위험 행동과 승인 경계가 정의됨
□ 최초 plan이 존재함
□ 복구 가능한 checkpoint가 존재함
```

조건을 만족하지 않으면 `EXECUTING`으로 들어가지 않고 `INTAKE`, `DISCOVERY`, `AWAITING_USER` 중 하나로 돌아간다.

# 5. 실행 중에도 대화가 끼어든다

사용자가 실행 중 질문하거나 방향을 바꿀 수 있다.

예:

```text
에이전트: 구현 중
사용자: 그런데 Redis를 추가하는 방향은 피하고 싶어.
```

이 메시지는 단순 대화가 아니라 기존 계획 전제를 변경한다.

따라서 사용자 입력을 다음처럼 분류해야 한다.

```text
QUESTION
├─ 현재 작업 상태를 바꾸지 않음
└─ 답변 후 실행 계속 가능

CLARIFICATION
├─ 기존 spec을 더 명확하게 함
└─ plan 재검토 가능

REQUIREMENT_CHANGE
├─ spec_version 증가
├─ 관련 plan/artifact invalidation
└─ 재계획 필요

PAUSE_REQUEST
└─ 안전 중단점 생성

CANCEL_REQUEST
└─ 롤백·정리 후 task 종료

APPROVAL_RESPONSE
└─ 보류된 위험 operation 실행 또는 취소
```

이 분류가 없으면 에이전트는 사용자의 질문을 새 요구사항으로 과잉 해석하거나, 실제 요구사항 변경을 단순 코멘트로 무시할 수 있다.

# 6. 정상적인 일시 중단

사용자가 “여기까지만 하고 나중에 계속하자”고 할 수 있다. 이 경우 즉시 프로세스를 끊어서는 안 된다.

`PAUSING` 단계에서 다음을 수행한다.

```text
1. 새로운 쓰기 operation 시작 중단
2. 현재 operation 완료 또는 안전 취소
3. 실행 중 프로세스 상태 기록
4. dirty diff 기록
5. 가능한 경우 checkpoint 또는 WIP commit 생성
6. 마지막 검증 상태 저장
7. 현재 plan step 상태 저장
8. unresolved question과 blocker 저장
9. 다음 안전 행동 저장
10. handoff packet 생성
11. episode를 SUSPENDED로 종료
```

## Handoff Packet

```yaml
task_id: TASK-42
attempt_id: ATTEMPT-2
session_id: SESSION-77
episode_id: EPISODE-4

spec_version: 4
plan_version: 6

workspace:
  id: WT-98
  branch: agent/task-42
  base_commit: 5bd3c8a
  head_commit: 91a72cd
  dirty_tree_hash: DIFF-19

current_state:
  phase: VERIFYING
  active_step: S5
  status: paused
  last_verified_checkpoint: CP-12

completed:
  - race 재현 테스트 추가
  - locking 구현

pending:
  - 전체 인증 회귀 테스트
  - lint 수정

failed_attempts:
  - optimistic retry만 추가하는 방식
  - reason: 중복 token 발급을 막지 못함

last_verification:
  command: pytest tests/auth/session
  result: 21 passed
  evidence_id: EV-139

next_safe_action:
  전체 auth 테스트 실행 후 lint 확인

open_questions:
  - Python 3.10 지원을 유지해야 하는가?
```

이 packet은 session transcript를 요약한 것이 아니라 Registry, Git, 테스트 결과, 계획 상태에서 **결정적으로 생성**되어야 한다.

# 7. 비정상 종료와 크래시

세션 종료 hook만으로는 충분하지 않다. 프로세스가 강제 종료되거나 머신이 꺼지면 `SessionEnd`가 실행되지 않을 수 있기 때문이다.

Codex는 `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop` 등의 lifecycle hook을 제공하지만, 정상 종료 hook 외에도 매 작업 전후에 지속적으로 상태를 기록해야 한다. ([OpenAI Developers][4])

## Write-Ahead Operation Journal

모든 부작용 작업 전에 다음을 먼저 저장한다.

```json
{
  "operation_id": "OP-455",
  "episode_id": "EP-4",
  "plan_step": "S4",
  "type": "file_edit",
  "target": "src/auth/session.py",
  "pre_state_hash": "HASH-A",
  "intended_effect": "serialize token refresh",
  "idempotency_key": "TASK42-S4-V2",
  "checkpoint_id": "CP-12",
  "status": "prepared"
}
```

실행 후:

```json
{
  "operation_id": "OP-455",
  "post_state_hash": "HASH-B",
  "evidence_id": "EV-128",
  "status": "committed"
}
```

프로세스가 중간에 죽으면 `prepared` 상태가 남는다.

```text
prepared
├─ 실제 변경 없음      → 재실행 가능
├─ 변경 완료, 기록 유실 → 상태 확인 후 committed 처리
├─ 일부만 변경됨        → repair 또는 rollback
└─ 판정 불가능          → 자동 재실행 금지, 조사 필요
```

이 구조가 없으면 복구한 에이전트가 같은 명령을 다시 실행해 다음을 일으킬 수 있다.

* 동일 migration 재실행
* 코드 생성 중복
* 패치 중복 적용
* 외부 API 중복 호출
* 테스트 fixture 중복 생성

# 8. 세션 복구 절차

사용자가 Codex `/resume` 또는 Claude Code resume를 실행했다고 해서 즉시 작업을 계속해서는 안 된다. Codex의 resume는 저장된 thread 기록을 다시 열고, fork는 기존 이력을 복제한 새 ID를 만든다. Claude Code 역시 session resume와 fork를 제공한다. 이것은 대화 재개 기능이지 환경 정합성 검증 기능은 아니다. ([OpenAI Developers][5])

복구는 다음 순서여야 한다.

## 8.1 Recovery Bootstrap

```text
1. session/thread ID 확인
2. session → task/attempt 매핑 조회
3. 새 episode_id 발급
4. 마지막 episode가 정상 종료됐는지 확인
5. 현재 cwd와 repo root 확인
6. 현재 worktree/branch/HEAD/dirty diff 측정
7. Registry의 마지막 상태와 비교
8. 미완료 operation 검색
9. 실행 중 프로세스·lock 확인
10. 테스트 결과의 유효성 확인
11. Hindsight에서 관련 경험 recall
12. 현재 plan 유효성 재평가
```

## 8.2 Workspace Reconciliation

### 경우 A: 완전히 일치

```text
예상 HEAD == 현재 HEAD
예상 dirty hash == 현재 dirty hash
환경 hash 일치
미완료 operation 없음
```

→ 동일 attempt와 plan을 계속할 수 있다.

### 경우 B: 코드는 같지만 세션만 새로 시작됨

예:

* context clear
* session transcript 손상
* 다른 클라이언트에서 새 session 시작

→ 기존 session을 억지로 복구할 필요 없이 **새 session + 기존 task/attempt + handoff packet**으로 이어갈 수 있다.

### 경우 C: workspace가 외부에서 변경됨

예:

* 사용자가 IDE에서 코드 수정
* remote branch를 pull
* dependency lock 변경
* 다른 도구가 포맷팅 수행

→ baseline을 다시 만들고 변경에 영향을 받는 plan과 검증 결과를 `stale` 처리한다.

### 경우 D: 기존 해결 전략과 충돌하는 대규모 변경

→ 기존 attempt를 종료하거나 보류하고 새 `attempt_id` 및 worktree를 생성한다.

### 경우 E: 목표 자체가 달라짐

→ 단순 spec revision인지 새로운 task인지 판정한다.

```text
원래 성공 조건이 유지되고 범위만 조정
→ 같은 task, spec_version 증가

최종 목적이 달라짐
→ 새 task_id
```

# 9. Resume와 Fork를 언제 쓸 것인가

| 상황                               | 권장                                               |
| -------------------------------- | ------------------------------------------------ |
| 동일 목표·동일 전략·동일 workspace         | 기존 session resume                                |
| 동일 목표·동일 전략이지만 이전 context 품질이 낮음 | 새 session + handoff                              |
| 다른 전략을 실험                        | session fork + 새 attempt/worktree                |
| 기존 작업을 보존하고 대안 비교                | fork                                             |
| 목표가 근본적으로 변경                     | 새 task                                           |
| workspace가 심하게 달라짐               | 새 episode에서 reconciliation 후 필요 시 새 attempt      |
| session 손상·복구 불가                 | 새 session + task state 복원                        |
| 단순 대화 후 실제 구현으로 전환               | 기존 session을 써도 되지만 task/attempt/workspace를 새로 등록 |

Codex App Server는 기존 thread를 ID로 resume하거나 특정 turn까지의 history로 fork할 수 있다. Claude Code의 fork 역시 원래 session을 보존하면서 새로운 session ID에서 다른 접근을 시도하는 용도다. ([OpenAI Developers][1])

# 10. Hindsight의 정확한 위치

Hindsight는 수명주기 전체에서 다음과 같이 사용한다.

## Intake

* 이전에 사용자가 선호했던 구현 방식 recall
* 같은 저장소에서 합의된 설계 원칙 recall
* 유사 작업에서 중요했던 질문 recall

단, 과거 선호를 현재 요구사항으로 자동 확정해서는 안 된다.

## Discovery

* 과거에 발견된 빌드·테스트 특이사항
* 취약한 모듈
* 이전 장애 경험
* 저장소의 비문서화된 관행

## Planning

* 유사 작업에서 성공·실패한 전략
* 과거 review 의견
* 아키텍처 결정과 이유

## Execution

* 동일 오류·도구 실패의 과거 경험
* 특정 명령의 주의사항
* 반복 실패 방지

## Recovery

* 이전 episode가 선택한 전략과 이유
* 실패한 접근
* 미해결 가설
* 다음 행동에 필요한 의미적 맥락

## Completion

* 검증된 새 저장소 지식 retain
* 성공한 절차
* 실패 패턴과 교훈
* 장기적으로 유지할 설계 결정

Hindsight는 기억 bank를 격리하고 `retain`, `recall`, `reflect`를 제공한다. 따라서 session별로 bank를 잘게 나누기보다, 내 설계 제안으로는 저장소 또는 사용자 단위 bank 안에서 `task_id`, `attempt_id`, `session_id`, `validity` 태그를 두는 편이 cross-session 회상에 더 적합하다. 세션별 bank로 분리하면 다른 session에서 같은 task의 기억을 다시 조합하기 어려워질 수 있다. ([Hindsight][6])

# 11. Hindsight 외에 필요한 핵심 구성요소

```text
Lifecycle Orchestrator
├─ Conversation / Task 구분
├─ 상태 머신
├─ phase 전환
└─ readiness / completion gate

Task & Session Registry
├─ task
├─ spec version
├─ attempt
├─ session
├─ episode
└─ workspace 매핑

Interaction Manager
├─ 인터뷰 질문
├─ 사용자 결정
├─ 요구사항 변경 분류
├─ 승인 요청
└─ pause/cancel 처리

Workspace State Manager
├─ repo / branch / HEAD
├─ dirty diff
├─ worktree
├─ environment fingerprint
└─ baseline

Plan & Specification Store
├─ task contract
├─ plan DAG
├─ 전제·산출물
├─ plan version
└─ invalidation

Operation Journal
├─ prepared
├─ running
├─ committed
├─ failed
└─ compensated

Checkpoint & Recovery Manager
├─ Git checkpoint
├─ WIP patch
├─ operation reconciliation
├─ idempotency
└─ rollback

Validation Orchestrator
├─ unit test
├─ integration test
├─ lint/type check
├─ build
├─ regression
└─ acceptance criteria

Evidence Store
├─ raw tool output
├─ logs
├─ test results
├─ diffs
└─ environment snapshots

Hindsight
├─ 장기 사실
├─ 경험
├─ 결정과 이유
├─ 실패 패턴
└─ cross-session semantic recall

Loop / Budget / Risk Controller
├─ 반복 탐지
├─ no-progress 탐지
├─ 비용 제한
├─ 수정 범위 제한
└─ 위험 행동 승인
```

# 12. 전체 동작 예시

## 첫 번째 세션

```text
SESSION-1 / EPISODE-1

사용자:
“로그인이 가끔 풀리는데 원인을 같이 봐줘.”

CONVERSATION
→ 아직 수정 task로 확정하지 않음

DISCOVERY
→ 로그와 코드를 읽기 전용으로 조사
→ token refresh race 가능성 발견

사용자:
“그 문제를 실제로 고쳐줘. API는 바꾸지 마.”

INTAKE
→ TASK-42 생성

SPECIFICATION
→ 성공 조건과 제약 확정

PREPARATION
→ ATTEMPT-1, WT-98 생성
→ baseline test 저장

READY
→ 실행 진입

EXECUTING
→ 재현 테스트 작성
→ 구현 도중 사용자가 pause 요청

PAUSING
→ checkpoint, handoff 생성

SUSPENDED
```

## 다음 날 새 세션

```text
SESSION-2 / EPISODE-2

SessionStart
→ SESSION-2가 TASK-42와 직접 연결되지 않았음을 감지
→ 사용자가 TASK-42 재개를 선택
→ handoff packet 로드
→ Git 상태 재측정

사용자가 IDE에서 파일 하나를 수정한 사실 발견
→ workspace divergence

RECOVERING
→ diff 분석
→ 기존 plan S3 일부 stale
→ baseline 갱신
→ plan-v4 생성

EXECUTING
→ 작업 계속
```

## 실행 중 크래시

```text
OP-77 status = prepared
에이전트 프로세스 종료
```

다음 episode:

```text
RECOVERING
→ OP-77 대상 파일 상태 확인
→ 수정은 완료됐지만 committed 기록만 유실됨
→ 중복 적용하지 않음
→ postcondition 검사
→ OP-77 committed 처리
→ 다음 단계 진행
```

# 최종 구조

이제 에이전틱 코딩 시스템을 다음처럼 정의할 수 있다.

```text
대화 계층
├─ 질문
├─ 인터뷰
├─ 선택
├─ 승인
└─ 피드백

작업 계층
├─ task
├─ spec
├─ attempt
├─ plan
└─ 완료 조건

실행 계층
├─ session
├─ episode
├─ workspace
├─ operation
└─ checkpoint

지식 계층
├─ Hindsight
├─ 저장소 규칙
├─ 과거 경험
└─ 설계 결정

증거 계층
├─ Git 상태
├─ 테스트
├─ 로그
├─ diff
└─ 도구 결과
```

핵심 원칙은 다섯 가지다.

> **대화가 곧 작업은 아니다.**
> **세션이 곧 작업 수명은 아니다.**
> **대화 재개가 곧 실행 상태 복구는 아니다.**
> **기억이 곧 현재 상태는 아니다.**
> **실행 루프는 목표·환경·검증 조건이 준비된 뒤에만 시작해야 한다.**

따라서 Codex·Claude Code 하네스의 중심은 단순한 agent loop가 아니라 다음이어야 한다.

```text
Lifecycle Orchestrator
  + Task/Spec Registry
  + Session/Episode Manager
  + Workspace Reconciler
  + Operation Journal
  + Plan Invalidation
  + Validator
  + Hindsight
```

Hindsight는 이 구조에서 **세션을 넘어 의미를 이어주는 기억층**이고, 세션 종료와 크래시에서 실제 작업을 안전하게 이어주는 것은 **Registry, Git 상태, operation journal, checkpoint, recovery protocol**이다.

[1]: https://developers.openai.com/codex/app-server?utm_source=chatgpt.com "Codex App Server | ChatGPT Learn - OpenAI Developers"
[2]: https://developers.openai.com/codex/customization/overview?utm_source=chatgpt.com "Customization | ChatGPT Learn - OpenAI Developers"
[3]: https://developers.openai.com/codex/environments/git-worktrees?utm_source=chatgpt.com "Worktrees | ChatGPT Learn - OpenAI Developers"
[4]: https://developers.openai.com/codex/hooks?utm_source=chatgpt.com "Hooks | ChatGPT Learn"
[5]: https://developers.openai.com/codex/learn/best-practices?utm_source=chatgpt.com "Best practices | ChatGPT Learn - OpenAI Developers"
[6]: https://hindsight.vectorize.io/?utm_source=chatgpt.com "Hindsight: Overview"
---
맞다. Codex·Claude Code형 에이전틱 코딩은 **하나의 실행 루프**가 아니라, 여러 종류의 대화와 작업 상태가 이어지는 **수명주기**로 모델링해야 한다.

사용자는 처음부터 “이 목표를 이 방식으로 구현하라”고 완성된 명세를 주지 않는다. 보통 다음이 섞여 있다.

* 문제를 설명하고 방향을 탐색하는 대화
* 코드베이스에 대한 질문
* 요구사항 인터뷰
* 구현 가능성 조사
* 대안 비교
* 실제 수정 요청
* 작업 중 요구사항 변경
* 일시 중단과 세션 종료
* 며칠 뒤 작업 재개
* 구현 검토와 추가 수정

따라서 올바른 구조는 다음과 같다.

```text
일반 대화
  ↓
작업 후보 식별
  ↓
요구사항 인터뷰
  ↓
저장소·환경 탐색
  ↓
목표·성공 조건 확정
  ↓
작업공간 및 기준 상태 설정
  ↓
계획 생성·검토
  ↓
실행 가능 상태 확인
  ↓
에이전틱 실행 루프
  ↕
질문 / 요구 변경 / 중단 / 복구 / 재계획
  ↓
최종 검증
  ↓
사용자 검토
  ↓
종료·인계·장기 기억 반영
```

Codex는 thread를 ID로 재개하거나 fork할 수 있고, Claude Code도 프로젝트 디렉터리에 연결된 세션을 저장하고 resume 또는 fork할 수 있다. 그러나 이것들은 **대화 이력의 연속성**을 제공할 뿐, 논리적 작업과 실제 작업공간이 여전히 일치한다는 보장은 아니다. ([OpenAI Developers][1])

# 1. 먼저 개념과 ID를 더 세분화해야 한다

앞 답변의 `task/session/workspace`만으로도 부족하다. 연속 실행 구간을 나타내는 `episode`가 추가로 필요하다.

```text
Repository
└─ Task
   ├─ Attempt
   │  ├─ Session
   │  │  ├─ Episode
   │  │  │  ├─ Turn
   │  │  │  └─ Tool Call / Operation
   │  │  └─ Episode
   │  └─ Workspace
   └─ Attempt
      └─ ...
```

| 객체              | 의미                                       |
| --------------- | ---------------------------------------- |
| `repo_id`       | 논리적 저장소                                  |
| `task_id`       | 사용자가 해결하려는 지속적인 목표                       |
| `spec_version`  | 현재 합의된 요구사항 버전                           |
| `attempt_id`    | 특정 해결 전략을 사용하는 시도                        |
| `session_id`    | Codex thread 또는 Claude Code conversation |
| `episode_id`    | 실행 시작·재개부터 중단·종료까지의 연속 활동 구간             |
| `workspace_id`  | 실제 checkout, worktree 또는 sandbox         |
| `plan_version`  | 현재 실행 계획의 버전                             |
| `checkpoint_id` | 검증된 복구 지점                                |
| `operation_id`  | 하나의 쓰기 작업 또는 외부 부작용                      |
| `evidence_id`   | 테스트·로그·diff 등 근거                         |

## 왜 Episode ID가 필요한가

같은 Claude Code session이나 Codex thread를 여러 번 resume할 수 있다.

```text
session-77
├─ episode-1: 요구사항 인터뷰와 조사
├─ episode-2: 구현 시작
├─ episode-3: 크래시 후 복구
└─ episode-4: 사용자 피드백 반영
```

`session_id`만 보면 이 네 구간이 하나로 보인다. 하지만 각 episode마다 다음이 다르다.

* 시작 당시 HEAD
* dirty working tree
* 환경 변수
* 실행 중 프로세스
* 유효한 계획 버전
* 미완료 operation
* 사용 가능한 권한
* 모델과 도구 버전

따라서 복구는 session 단위가 아니라 **episode 경계에서 수행**해야 한다.

# 2. 모든 대화를 작업으로 등록하면 안 된다

에이전트는 처음에는 `CHAT` 또는 `EXPLORATION` 상태에 있어야 한다.

```text
CHAT
├─ 코드 설명
├─ 아이디어 논의
├─ 설계 대안 비교
├─ 오류 메시지 해석
└─ 읽기 전용 코드 조사
```

다음과 같은 조건이 만족될 때만 지속적인 `Task`를 생성한다.

* 사용자가 코드 또는 환경 변경을 요청함
* 여러 단계에 걸쳐 지속해야 하는 목표가 생김
* 중단 후 재개할 가치가 있음
* 검증 가능한 완료 조건이 존재함
* 작업 이력과 변경 상태를 추적할 필요가 있음

즉 하네스에 **Task Commitment Gate**가 필요하다.

```text
사용자 메시지
  ↓
일반 질문인가?
  ├─ 예 → 대화 상태 유지
  └─ 아니오
      ↓
지속 작업인가?
  ├─ 아니오 → 단일 turn 작업
  └─ 예 → task 후보 생성
             ↓
          사용자와 목표 확정
             ↓
          정식 task 생성
```

단순히 “이 코드가 왜 이래?”라고 묻는 순간 task와 worktree를 만드는 것은 과도하다. 반대로 대화 중 사용자가 “좋아, 그 방식으로 실제 수정해줘”라고 말하면 그 시점에 task를 승격해야 한다.

# 3. 전체 수명주기 상태 머신

권장 상태는 다음과 같다.

```text
IDLE
│
├─ CONVERSATION
│  ├─ 질문·답변
│  ├─ 설계 논의
│  └─ 읽기 전용 탐색
│
├─ INTAKE
│  ├─ 작업 후보 등록
│  ├─ 사용자 의도 수집
│  └─ 요구사항 인터뷰
│
├─ DISCOVERY
│  ├─ 저장소 구조 조사
│  ├─ 문제 재현
│  ├─ 관련 코드 탐색
│  └─ 환경 제약 확인
│
├─ SPECIFICATION
│  ├─ 목표
│  ├─ 범위
│  ├─ 제외 범위
│  ├─ 성공 조건
│  └─ 위험·승인 조건 확정
│
├─ PREPARATION
│  ├─ workspace 선택·생성
│  ├─ baseline 기록
│  ├─ 의존성 설치·확인
│  ├─ 초기 테스트
│  └─ plan 작성
│
├─ READY
│  └─ 실행 진입 조건 확인
│
├─ EXECUTING
│  ├─ 관찰
│  ├─ 행동 선택
│  ├─ 실행
│  ├─ 상태 재관찰
│  └─ 국소 검증
│
├─ VERIFYING
│  ├─ 테스트
│  ├─ 회귀 검사
│  ├─ diff 검토
│  └─ 성공 조건 판정
│
├─ REPLANNING
│  ├─ 잘못된 전제 탐지
│  ├─ 영향 범위 계산
│  └─ plan 수정
│
├─ AWAITING_USER
│  ├─ 요구사항 질문
│  ├─ 위험 행동 승인
│  ├─ 대안 선택
│  └─ 결과 검토 요청
│
├─ PAUSING
│  └─ 안전한 중단점 생성
│
├─ SUSPENDED
│  └─ 명시적으로 중단된 작업
│
├─ INTERRUPTED
│  └─ 비정상 종료 또는 연결 유실
│
├─ RECOVERING
│  ├─ 상태 재구성
│  ├─ 미완료 operation 판정
│  └─ plan 유효성 재평가
│
├─ COMPLETING
│  ├─ 최종 정리
│  ├─ 사용자 인계
│  └─ 기억·근거 저장
│
├─ COMPLETED
├─ ABANDONED
└─ FAILED
```

중요한 것은 `EXECUTING`만 반복 루프가 아니라는 점이다. 실제로는 다음과 같은 여러 루프가 존재한다.

```text
인터뷰 루프
탐색 루프
계획 검토 루프
실행 루프
검증 루프
복구 루프
사용자 피드백 루프
```

# 4. 루프 진입 전 단계

## 4.1 Intake: 요구사항 인터뷰

처음부터 모든 요구사항을 확정하려 해서는 안 된다. 사용자의 진술을 다음처럼 분리해야 한다.

```text
confirmed_requirement
provisional_requirement
assumption
open_question
rejected_option
user_preference
out_of_scope
```

예:

```json
{
  "statement": "기존 API 호환성은 유지해야 한다",
  "type": "confirmed_requirement",
  "source_turn_id": "TURN-18",
  "confirmed_at": "2026-07-24T10:05:00+09:00"
}
```

반면 에이전트가 “아마 PostgreSQL만 지원하면 될 것 같다”고 추정한 것은 `assumption`이어야 한다.

Hindsight에는 모든 대화를 그대로 권위 있는 사실로 넣기보다, 다음만 장기 기억으로 승격하는 편이 좋다.

* 사용자가 확인한 요구사항
* 명시적으로 선택한 설계 방향
* 거절한 대안과 이유
* 장기적으로 유용한 저장소 지식

잠정 아이디어와 브레인스토밍을 사실처럼 저장하면 이후 세션에서 오래된 가정이 되살아날 수 있다.

## 4.2 Discovery: 읽기 전용 탐색

실행 루프 전에 별도의 탐색 단계가 필요하다.

```text
저장소 root 확인
AGENTS.md / CLAUDE.md 확인
Git 상태 확인
현재 branch와 HEAD 확인
빌드·테스트 방법 탐색
문제 재현
관련 symbol과 파일 탐색
기존 설계와 테스트 패턴 확인
외부 서비스·환경 의존성 확인
```

Codex에서는 `AGENTS.md`가 행동 지침을 제공하고, memories가 로컬 맥락을 전달하며, skills와 MCP가 반복 절차와 외부 시스템을 연결한다. 공식 문서도 이들을 경쟁 관계가 아닌 보완 관계로 설명한다. ([OpenAI Developers][2])

이 단계에서는 원칙적으로 쓰기 권한을 제한하는 것이 좋다.

```text
Discovery mode:
├─ 파일 읽기 허용
├─ 검색 허용
├─ 안전한 테스트 허용
├─ Git diff 조회 허용
├─ 외부 정보 조회 허용
└─ 코드 수정·삭제·배포 금지
```

## 4.3 Specification: Task Contract 작성

탐색 결과를 바탕으로 task contract를 만든다.

```yaml
task_id: TASK-42
spec_version: 3

goal:
  로그인 세션 갱신 중 발생하는 race condition을 제거한다.

success_conditions:
  - 기존 재현 테스트가 통과한다.
  - 새 동시성 회귀 테스트가 통과한다.
  - 공개 API 동작은 변경하지 않는다.
  - 전체 인증 테스트가 통과한다.

scope:
  - auth/session 모듈
  - 관련 데이터 접근 코드
  - 회귀 테스트

out_of_scope:
  - 인증 시스템 전면 재설계
  - 데이터베이스 교체

constraints:
  - 데이터베이스 migration 금지
  - 외부 API 호환성 유지

approval_required:
  - dependency 추가
  - 공개 API 변경
  - 10개 이상 파일 수정
```

여기서 중요한 것은 요구사항이 변경될 때 기존 task를 덮어쓰지 않고 `spec_version`을 올리는 것이다.

```text
spec-v3
  ↓ 사용자 요구 변경
spec-v4
  ↓
영향받는 plan/artifact/test를 stale 처리
```

## 4.4 Preparation: 초기 상태 설정

실행을 시작하기 전에 baseline을 고정한다.

```json
{
  "workspace_id": "WT-98",
  "repo_id": "REPO-7",
  "branch": "agent/task-42",
  "base_commit": "5bd3c8a",
  "head_commit": "5bd3c8a",
  "dirty_tree_hash": null,
  "dependency_lock_hash": "LOCK-77",
  "environment_hash": "ENV-12",
  "baseline_tests": {
    "command": "pytest tests/auth",
    "passed": 79,
    "failed": 1,
    "evidence_id": "EV-101"
  }
}
```

Codex는 독립 checkout을 제공하는 Git worktree를 지원하고, Claude Code는 세션별 체크포인트와 권한 기능을 제공한다. 그러나 체크포인트와 대화 세션은 Git commit 및 실제 환경 baseline을 대체하지 않으므로, 권위 있는 기준점은 여전히 Git과 별도 상태 저장소로 관리해야 한다. ([OpenAI Developers][3])

## 4.5 Readiness Gate

다음 조건을 만족할 때만 본격적인 실행 루프를 시작한다.

```text
□ task contract가 존재함
□ 사용자의 미해결 필수 질문이 없음
□ repo와 workspace가 식별됨
□ Git baseline이 기록됨
□ 재현 또는 현재 상태가 확인됨
□ 성공 조건이 기계적으로 또는 수동으로 판정 가능함
□ 위험 행동과 승인 경계가 정의됨
□ 최초 plan이 존재함
□ 복구 가능한 checkpoint가 존재함
```

조건을 만족하지 않으면 `EXECUTING`으로 들어가지 않고 `INTAKE`, `DISCOVERY`, `AWAITING_USER` 중 하나로 돌아간다.

# 5. 실행 중에도 대화가 끼어든다

사용자가 실행 중 질문하거나 방향을 바꿀 수 있다.

예:

```text
에이전트: 구현 중
사용자: 그런데 Redis를 추가하는 방향은 피하고 싶어.
```

이 메시지는 단순 대화가 아니라 기존 계획 전제를 변경한다.

따라서 사용자 입력을 다음처럼 분류해야 한다.

```text
QUESTION
├─ 현재 작업 상태를 바꾸지 않음
└─ 답변 후 실행 계속 가능

CLARIFICATION
├─ 기존 spec을 더 명확하게 함
└─ plan 재검토 가능

REQUIREMENT_CHANGE
├─ spec_version 증가
├─ 관련 plan/artifact invalidation
└─ 재계획 필요

PAUSE_REQUEST
└─ 안전 중단점 생성

CANCEL_REQUEST
└─ 롤백·정리 후 task 종료

APPROVAL_RESPONSE
└─ 보류된 위험 operation 실행 또는 취소
```

이 분류가 없으면 에이전트는 사용자의 질문을 새 요구사항으로 과잉 해석하거나, 실제 요구사항 변경을 단순 코멘트로 무시할 수 있다.

# 6. 정상적인 일시 중단

사용자가 “여기까지만 하고 나중에 계속하자”고 할 수 있다. 이 경우 즉시 프로세스를 끊어서는 안 된다.

`PAUSING` 단계에서 다음을 수행한다.

```text
1. 새로운 쓰기 operation 시작 중단
2. 현재 operation 완료 또는 안전 취소
3. 실행 중 프로세스 상태 기록
4. dirty diff 기록
5. 가능한 경우 checkpoint 또는 WIP commit 생성
6. 마지막 검증 상태 저장
7. 현재 plan step 상태 저장
8. unresolved question과 blocker 저장
9. 다음 안전 행동 저장
10. handoff packet 생성
11. episode를 SUSPENDED로 종료
```

## Handoff Packet

```yaml
task_id: TASK-42
attempt_id: ATTEMPT-2
session_id: SESSION-77
episode_id: EPISODE-4

spec_version: 4
plan_version: 6

workspace:
  id: WT-98
  branch: agent/task-42
  base_commit: 5bd3c8a
  head_commit: 91a72cd
  dirty_tree_hash: DIFF-19

current_state:
  phase: VERIFYING
  active_step: S5
  status: paused
  last_verified_checkpoint: CP-12

completed:
  - race 재현 테스트 추가
  - locking 구현

pending:
  - 전체 인증 회귀 테스트
  - lint 수정

failed_attempts:
  - optimistic retry만 추가하는 방식
  - reason: 중복 token 발급을 막지 못함

last_verification:
  command: pytest tests/auth/session
  result: 21 passed
  evidence_id: EV-139

next_safe_action:
  전체 auth 테스트 실행 후 lint 확인

open_questions:
  - Python 3.10 지원을 유지해야 하는가?
```

이 packet은 session transcript를 요약한 것이 아니라 Registry, Git, 테스트 결과, 계획 상태에서 **결정적으로 생성**되어야 한다.

# 7. 비정상 종료와 크래시

세션 종료 hook만으로는 충분하지 않다. 프로세스가 강제 종료되거나 머신이 꺼지면 `SessionEnd`가 실행되지 않을 수 있기 때문이다.

Codex는 `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop` 등의 lifecycle hook을 제공하지만, 정상 종료 hook 외에도 매 작업 전후에 지속적으로 상태를 기록해야 한다. ([OpenAI Developers][4])

## Write-Ahead Operation Journal

모든 부작용 작업 전에 다음을 먼저 저장한다.

```json
{
  "operation_id": "OP-455",
  "episode_id": "EP-4",
  "plan_step": "S4",
  "type": "file_edit",
  "target": "src/auth/session.py",
  "pre_state_hash": "HASH-A",
  "intended_effect": "serialize token refresh",
  "idempotency_key": "TASK42-S4-V2",
  "checkpoint_id": "CP-12",
  "status": "prepared"
}
```

실행 후:

```json
{
  "operation_id": "OP-455",
  "post_state_hash": "HASH-B",
  "evidence_id": "EV-128",
  "status": "committed"
}
```

프로세스가 중간에 죽으면 `prepared` 상태가 남는다.

```text
prepared
├─ 실제 변경 없음      → 재실행 가능
├─ 변경 완료, 기록 유실 → 상태 확인 후 committed 처리
├─ 일부만 변경됨        → repair 또는 rollback
└─ 판정 불가능          → 자동 재실행 금지, 조사 필요
```

이 구조가 없으면 복구한 에이전트가 같은 명령을 다시 실행해 다음을 일으킬 수 있다.

* 동일 migration 재실행
* 코드 생성 중복
* 패치 중복 적용
* 외부 API 중복 호출
* 테스트 fixture 중복 생성

# 8. 세션 복구 절차

사용자가 Codex `/resume` 또는 Claude Code resume를 실행했다고 해서 즉시 작업을 계속해서는 안 된다. Codex의 resume는 저장된 thread 기록을 다시 열고, fork는 기존 이력을 복제한 새 ID를 만든다. Claude Code 역시 session resume와 fork를 제공한다. 이것은 대화 재개 기능이지 환경 정합성 검증 기능은 아니다. ([OpenAI Developers][5])

복구는 다음 순서여야 한다.

## 8.1 Recovery Bootstrap

```text
1. session/thread ID 확인
2. session → task/attempt 매핑 조회
3. 새 episode_id 발급
4. 마지막 episode가 정상 종료됐는지 확인
5. 현재 cwd와 repo root 확인
6. 현재 worktree/branch/HEAD/dirty diff 측정
7. Registry의 마지막 상태와 비교
8. 미완료 operation 검색
9. 실행 중 프로세스·lock 확인
10. 테스트 결과의 유효성 확인
11. Hindsight에서 관련 경험 recall
12. 현재 plan 유효성 재평가
```

## 8.2 Workspace Reconciliation

### 경우 A: 완전히 일치

```text
예상 HEAD == 현재 HEAD
예상 dirty hash == 현재 dirty hash
환경 hash 일치
미완료 operation 없음
```

→ 동일 attempt와 plan을 계속할 수 있다.

### 경우 B: 코드는 같지만 세션만 새로 시작됨

예:

* context clear
* session transcript 손상
* 다른 클라이언트에서 새 session 시작

→ 기존 session을 억지로 복구할 필요 없이 **새 session + 기존 task/attempt + handoff packet**으로 이어갈 수 있다.

### 경우 C: workspace가 외부에서 변경됨

예:

* 사용자가 IDE에서 코드 수정
* remote branch를 pull
* dependency lock 변경
* 다른 도구가 포맷팅 수행

→ baseline을 다시 만들고 변경에 영향을 받는 plan과 검증 결과를 `stale` 처리한다.

### 경우 D: 기존 해결 전략과 충돌하는 대규모 변경

→ 기존 attempt를 종료하거나 보류하고 새 `attempt_id` 및 worktree를 생성한다.

### 경우 E: 목표 자체가 달라짐

→ 단순 spec revision인지 새로운 task인지 판정한다.

```text
원래 성공 조건이 유지되고 범위만 조정
→ 같은 task, spec_version 증가

최종 목적이 달라짐
→ 새 task_id
```

# 9. Resume와 Fork를 언제 쓸 것인가

| 상황                               | 권장                                               |
| -------------------------------- | ------------------------------------------------ |
| 동일 목표·동일 전략·동일 workspace         | 기존 session resume                                |
| 동일 목표·동일 전략이지만 이전 context 품질이 낮음 | 새 session + handoff                              |
| 다른 전략을 실험                        | session fork + 새 attempt/worktree                |
| 기존 작업을 보존하고 대안 비교                | fork                                             |
| 목표가 근본적으로 변경                     | 새 task                                           |
| workspace가 심하게 달라짐               | 새 episode에서 reconciliation 후 필요 시 새 attempt      |
| session 손상·복구 불가                 | 새 session + task state 복원                        |
| 단순 대화 후 실제 구현으로 전환               | 기존 session을 써도 되지만 task/attempt/workspace를 새로 등록 |

Codex App Server는 기존 thread를 ID로 resume하거나 특정 turn까지의 history로 fork할 수 있다. Claude Code의 fork 역시 원래 session을 보존하면서 새로운 session ID에서 다른 접근을 시도하는 용도다. ([OpenAI Developers][1])

# 10. Hindsight의 정확한 위치

Hindsight는 수명주기 전체에서 다음과 같이 사용한다.

## Intake

* 이전에 사용자가 선호했던 구현 방식 recall
* 같은 저장소에서 합의된 설계 원칙 recall
* 유사 작업에서 중요했던 질문 recall

단, 과거 선호를 현재 요구사항으로 자동 확정해서는 안 된다.

## Discovery

* 과거에 발견된 빌드·테스트 특이사항
* 취약한 모듈
* 이전 장애 경험
* 저장소의 비문서화된 관행

## Planning

* 유사 작업에서 성공·실패한 전략
* 과거 review 의견
* 아키텍처 결정과 이유

## Execution

* 동일 오류·도구 실패의 과거 경험
* 특정 명령의 주의사항
* 반복 실패 방지

## Recovery

* 이전 episode가 선택한 전략과 이유
* 실패한 접근
* 미해결 가설
* 다음 행동에 필요한 의미적 맥락

## Completion

* 검증된 새 저장소 지식 retain
* 성공한 절차
* 실패 패턴과 교훈
* 장기적으로 유지할 설계 결정

Hindsight는 기억 bank를 격리하고 `retain`, `recall`, `reflect`를 제공한다. 따라서 session별로 bank를 잘게 나누기보다, 내 설계 제안으로는 저장소 또는 사용자 단위 bank 안에서 `task_id`, `attempt_id`, `session_id`, `validity` 태그를 두는 편이 cross-session 회상에 더 적합하다. 세션별 bank로 분리하면 다른 session에서 같은 task의 기억을 다시 조합하기 어려워질 수 있다. ([Hindsight][6])

# 11. Hindsight 외에 필요한 핵심 구성요소

```text
Lifecycle Orchestrator
├─ Conversation / Task 구분
├─ 상태 머신
├─ phase 전환
└─ readiness / completion gate

Task & Session Registry
├─ task
├─ spec version
├─ attempt
├─ session
├─ episode
└─ workspace 매핑

Interaction Manager
├─ 인터뷰 질문
├─ 사용자 결정
├─ 요구사항 변경 분류
├─ 승인 요청
└─ pause/cancel 처리

Workspace State Manager
├─ repo / branch / HEAD
├─ dirty diff
├─ worktree
├─ environment fingerprint
└─ baseline

Plan & Specification Store
├─ task contract
├─ plan DAG
├─ 전제·산출물
├─ plan version
└─ invalidation

Operation Journal
├─ prepared
├─ running
├─ committed
├─ failed
└─ compensated

Checkpoint & Recovery Manager
├─ Git checkpoint
├─ WIP patch
├─ operation reconciliation
├─ idempotency
└─ rollback

Validation Orchestrator
├─ unit test
├─ integration test
├─ lint/type check
├─ build
├─ regression
└─ acceptance criteria

Evidence Store
├─ raw tool output
├─ logs
├─ test results
├─ diffs
└─ environment snapshots

Hindsight
├─ 장기 사실
├─ 경험
├─ 결정과 이유
├─ 실패 패턴
└─ cross-session semantic recall

Loop / Budget / Risk Controller
├─ 반복 탐지
├─ no-progress 탐지
├─ 비용 제한
├─ 수정 범위 제한
└─ 위험 행동 승인
```

# 12. 전체 동작 예시

## 첫 번째 세션

```text
SESSION-1 / EPISODE-1

사용자:
“로그인이 가끔 풀리는데 원인을 같이 봐줘.”

CONVERSATION
→ 아직 수정 task로 확정하지 않음

DISCOVERY
→ 로그와 코드를 읽기 전용으로 조사
→ token refresh race 가능성 발견

사용자:
“그 문제를 실제로 고쳐줘. API는 바꾸지 마.”

INTAKE
→ TASK-42 생성

SPECIFICATION
→ 성공 조건과 제약 확정

PREPARATION
→ ATTEMPT-1, WT-98 생성
→ baseline test 저장

READY
→ 실행 진입

EXECUTING
→ 재현 테스트 작성
→ 구현 도중 사용자가 pause 요청

PAUSING
→ checkpoint, handoff 생성

SUSPENDED
```

## 다음 날 새 세션

```text
SESSION-2 / EPISODE-2

SessionStart
→ SESSION-2가 TASK-42와 직접 연결되지 않았음을 감지
→ 사용자가 TASK-42 재개를 선택
→ handoff packet 로드
→ Git 상태 재측정

사용자가 IDE에서 파일 하나를 수정한 사실 발견
→ workspace divergence

RECOVERING
→ diff 분석
→ 기존 plan S3 일부 stale
→ baseline 갱신
→ plan-v4 생성

EXECUTING
→ 작업 계속
```

## 실행 중 크래시

```text
OP-77 status = prepared
에이전트 프로세스 종료
```

다음 episode:

```text
RECOVERING
→ OP-77 대상 파일 상태 확인
→ 수정은 완료됐지만 committed 기록만 유실됨
→ 중복 적용하지 않음
→ postcondition 검사
→ OP-77 committed 처리
→ 다음 단계 진행
```

# 최종 구조

이제 에이전틱 코딩 시스템을 다음처럼 정의할 수 있다.

```text
대화 계층
├─ 질문
├─ 인터뷰
├─ 선택
├─ 승인
└─ 피드백

작업 계층
├─ task
├─ spec
├─ attempt
├─ plan
└─ 완료 조건

실행 계층
├─ session
├─ episode
├─ workspace
├─ operation
└─ checkpoint

지식 계층
├─ Hindsight
├─ 저장소 규칙
├─ 과거 경험
└─ 설계 결정

증거 계층
├─ Git 상태
├─ 테스트
├─ 로그
├─ diff
└─ 도구 결과
```

핵심 원칙은 다섯 가지다.

> **대화가 곧 작업은 아니다.**
> **세션이 곧 작업 수명은 아니다.**
> **대화 재개가 곧 실행 상태 복구는 아니다.**
> **기억이 곧 현재 상태는 아니다.**
> **실행 루프는 목표·환경·검증 조건이 준비된 뒤에만 시작해야 한다.**

따라서 Codex·Claude Code 하네스의 중심은 단순한 agent loop가 아니라 다음이어야 한다.

```text
Lifecycle Orchestrator
  + Task/Spec Registry
  + Session/Episode Manager
  + Workspace Reconciler
  + Operation Journal
  + Plan Invalidation
  + Validator
  + Hindsight
```

Hindsight는 이 구조에서 **세션을 넘어 의미를 이어주는 기억층**이고, 세션 종료와 크래시에서 실제 작업을 안전하게 이어주는 것은 **Registry, Git 상태, operation journal, checkpoint, recovery protocol**이다.

---

이 조건이면 Hindsight는 별도의 설치·확장 대상이 아니라 **공유 인프라 서비스**로 간주하면 된다.

```text
모든 머신
└─ http://127.0.0.1:8888
       ↓ Tailscale routing
공용 Hindsight 인스턴스
```

Hindsight 서버에는 extension·hook·MCP를 설치하지 않는다. OMP 포크의 클라이언트 코드가 직접 `retain`, `recall`, 필요할 때만 `reflect`를 호출한다. Hindsight는 기본 HTTP API만으로 bank, tag, metadata, document ID를 지원하고, bank는 서로 격리된다. 같은 `document_id`를 다시 retain하면 이전 문서의 사실을 대체할 수도 있다. ([GitHub][1])

다만 여기서 중요한 설계 변경이 있다.

> **Hindsight가 공용이라고 해서 task 상태까지 Hindsight에 넣어서는 안 된다.**

여러 머신에서 작업을 옮겨 다니려면 Hindsight 외에 **공용 Workflow Registry**가 반드시 필요하다.

---

# 1. 최종 권장 배치

```text
┌───────────────────────────────────────────────────────────┐
│ 머신 A                                                    │
│                                                           │
│ OMP Fork                                                  │
│ ├─ Workflow Extension                                     │
│ ├─ Local Runtime DB                                       │
│ ├─ Git worktree                                           │
│ └─ Hindsight Gateway ──────────────┐                       │
│                                    │                       │
│ http://127.0.0.1:8888 ─────────────┼── Tailscale routing ──┐
│ http://127.0.0.1:8890 ─────────────┼── Tailscale routing ──┤
└────────────────────────────────────┘                       │
                                                             │
┌───────────────────────────────────────────────────────────┐│
│ 머신 B                                                    ││
│                                                           ││
│ OMP Fork                                                  ││
│ ├─ Workflow Extension                                     ││
│ ├─ Local Runtime DB                                       ││
│ ├─ Git worktree                                           ││
│ └─ Hindsight Gateway ──────────────┐                      ││
│                                    │                      ││
│ http://127.0.0.1:8888 ─────────────┼──────────────────────┤
│ http://127.0.0.1:8890 ─────────────┼──────────────────────┤
└────────────────────────────────────┘                      │
                                                            │
                     ┌──────────────────────────────────────┘
                     │
         ┌───────────▼────────────────────────────┐
         │ 공용 서비스                            │
         │                                        │
         │ :8888 Hindsight                        │
         │ ├─ 사용자 기억 bank                    │
         │ ├─ 저장소별 기억 bank                  │
         │ └─ retain / recall / reflect            │
         │                                        │
         │ :8890 Workflow Coordinator             │
         │ ├─ Task/Spec/Attempt                    │
         │ ├─ Session/Episode mapping              │
         │ ├─ Plan DAG                             │
         │ ├─ Workspace lease                      │
         │ └─ 공유 이벤트 로그                    │
         │                                        │
         │ Git checkpoint remote                  │
         │ └─ 머신 간 코드 상태 전달              │
         └────────────────────────────────────────┘
```

`8890`은 예시다. Hindsight처럼 모든 머신에서 `localhost`로 보이도록 라우팅하는 것이 가장 단순하다.

---

# 2. 데이터를 세 종류로 나눈다

## A. Hindsight에 저장할 것

의미적이고 장기적으로 다시 쓸 수 있는 지식이다.

```text
저장소 지식
├─ 빌드 방법
├─ 테스트 특이사항
├─ 아키텍처 규칙
├─ 숨은 생성 절차
├─ 모듈별 역할
└─ 자주 발생하는 함정

설계 결정
├─ 선택한 전략
├─ 선택한 이유
├─ 배제한 대안
└─ 해당 결정의 유효 조건

경험
├─ 실패한 접근법
├─ 실패한 이유
├─ 성공한 복구 방법
├─ 특정 도구의 주의사항
└─ 리뷰에서 반복되는 지적

사용자 선호
├─ 새 의존성 최소화
├─ API 호환성 우선
├─ 명시적 타입 선호
└─ 특정 테스트·문서 형식
```

## B. 공용 Workflow Coordinator에 저장할 것

여러 머신이 동일하게 알아야 하는 **현재 작업 상태**다.

```text
Task
Spec version
Attempt
Plan version
Plan step 상태
어떤 머신과 세션이 작업 중인지
Workspace lease
마지막 공유 checkpoint
검증 결과 요약
pause/interrupted/completed 상태
```

## C. 각 머신의 Local Runtime DB에 저장할 것

해당 머신에서만 실제로 관찰 가능한 실행 상태다.

```text
현재 로컬 경로
실행 중 PID
tool call journal
실행 직전·직후 Git snapshot
아직 전송하지 못한 coordinator event
아직 retain하지 못한 Hindsight memory
로컬 dirty diff
미완료 shell command
```

정리하면:

```text
장기 지식          → Hindsight
공유 작업 상태     → Workflow Coordinator
로컬 실행 상태     → Local Runtime DB
코드 상태          → Git/worktree
```

---

# 3. 기존 OMP Hindsight 구현을 어떻게 다룰 것인가

OMP에는 이미 Hindsight용 클라이언트, model-facing `retain`·`recall`·`reflect`, 자동 recall·retain 수명주기가 존재한다. 이 통합은 Hindsight 서버 extension을 요구하지 않고, 클라이언트가 HTTP API에 직접 연결하는 방식이다. 최근 OMP 구현은 의존성과 재시도·테스트 제어를 위해 Hindsight SDK 대신 직접 fetch하는 클라이언트를 사용하는 것으로 설명되어 있다. ([GitHub][2])

따라서 포크에서는 Hindsight 클라이언트를 새로 만들 필요가 없다.

```text
재사용
└─ packages/coding-agent/src/hindsight/client.ts

교체 또는 비활성화
├─ 기존 모든-session 자동 retain
├─ 기존 첫-turn 무조건 recall
└─ 모델이 임의로 호출하는 무제한 memory tool

새로 추가
└─ workflow-aware memory policy
```

기존 자동 retain과 새 workflow retain을 동시에 켜면 동일 대화가 중복 저장되고, 임시 가설과 확정 사실이 섞일 가능성이 높다. OMP에서도 빈 assistant 메시지나 worktree별 프로젝트 scope가 기억을 오염·분절시키는 문제가 보고된 바 있다. ([GitHub][3])

---

# 4. Hindsight bank 설계

## 권장: 사용자 bank + 저장소별 bank

```text
omp-user-v1
└─ 사용자의 범용 선호와 작업 방식

omp-repo-<repo-id>
└─ 해당 저장소의 기술 지식과 작업 경험
```

Task별 bank는 만들지 않는 편이 좋다. Task마다 bank를 만들면 과거 작업에서 배운 지식이 다른 task로 전달되기 어렵다.

Task와 attempt는 bank가 아니라 tag로 구분한다.

## Bank ID 예

```ts
function userBankId(userId: string): string {
  return `omp-user-v1-${safeHash(userId)}`;
}

function repoBankId(repoId: string): string {
  return `omp-repo-v1-${repoId}`;
}
```

Hindsight의 bank는 완전히 격리되며 처음 사용할 때 자동 생성할 수 있으므로 저장소별 bank 방식이 안전하다. ([Hindsight][4])

---

# 5. 여러 머신에서 동일한 `repo_id` 만들기

로컬 경로는 사용하면 안 된다.

```text
머신 A: /Users/me/code/project
머신 B: /home/me/src/project
```

두 경로는 다르지만 같은 저장소다.

## 우선순위

```text
1. 저장소 설정에 명시된 repo UUID
2. 정규화된 canonical remote URL
3. GitHub/GitLab repository ID
4. 최초 commit + repository name
5. 최후 수단으로 사용자가 발급한 UUID
```

## 저장소 설정

저장소에 다음 파일을 두는 방법이 가장 확실하다.

```yaml
# .omp-agent/project.yml

repositoryId: 01J4ZB8T56KME3Q1D1R6QPGM51
canonicalRemote: github.com/example/project

memory:
  bank: omp-repo-v1-01J4ZB8T56KME3Q1D1R6QPGM51
```

이 파일은 코드와 함께 commit해도 되고, private 프로젝트에서는 별도 설정 저장소로 관리해도 된다.

remote URL을 사용한다면 SSH와 HTTPS 주소를 정규화해야 한다.

```text
git@github.com:example/project.git
https://github.com/example/project.git

→ github.com/example/project
```

---

# 6. Hindsight tag 규칙

공용 인스턴스에서는 tag 규칙을 엄격하게 해야 한다.

```text
repo:<repo-id>
task:<task-id>
attempt:<attempt-id>
kind:<memory-kind>
status:<status>
source:<source-type>
spec:<version>
```

예:

```json
{
  "tags": [
    "repo:01J4ZB8T56KME3Q1D1R6QPGM51",
    "task:TASK-42",
    "attempt:ATTEMPT-2",
    "kind:failed-approach",
    "status:active",
    "source:agent"
  ]
}
```

Hindsight recall은 tag를 DB 수준에서 필터링하며, `all_strict`를 사용하면 지정된 tag가 모두 있는 기억만 가져오고 untagged 기억을 제외할 수 있다. 복합 `tag_groups`를 사용해 특정 task 기억은 포함하되 `archived`나 `superseded` 기억은 제외할 수도 있다. ([Hindsight][5])

## Task별 recall

```ts
await hindsight.recall(repoBank, query, {
  tags: [
    `task:${taskId}`,
  ],
  tagsMatch: "all_strict",
  maxTokens: 1800,
});
```

## 저장소 일반 지식 recall

```ts
await hindsight.recall(repoBank, query, {
  tags: [
    `kind:repo-fact`,
  ],
  tagsMatch: "all_strict",
  maxTokens: 1200,
});
```

## Task 기억 + 저장소 일반 기억

한 번의 느슨한 query로 섞기보다 두 번 recall한 뒤 클라이언트가 합친다.

```text
Recall A: task-specific
Recall B: repo-wide
Recall C: user preference

→ 중복 제거
→ 출처와 최신성 표시
→ 총 token budget 내에서 병합
```

---

# 7. `machine_id`, `session_id`, `episode_id`

공용 Hindsight에서는 출처를 명확히 기록해야 한다.

## 머신 ID

각 머신에 영구 ID를 하나 만든다.

```text
~/.config/omp-agent/machine-id
```

내용:

```text
01J7MACHINE8T0CPN6VWDC98Z4E
```

처음 실행 시 생성하고 이후 유지한다.

호스트 이름은 바뀔 수 있고 중복될 수 있으므로 primary key로 사용하지 않는다.

## Session key

OMP session ID는 머신 정보와 함께 기록한다.

```text
session_key =
  <machine_id>:<omp_session_id>
```

## Episode

한 session이 여러 번 resume될 수 있으므로 episode는 매 실행 시 새로 발급한다.

```text
session S1
├─ episode E1: 머신 A에서 시작
├─ episode E2: 머신 A에서 resume
└─ episode E3: 머신 B에서 새 session으로 handoff
```

## Hindsight metadata

```json
{
  "metadata": {
    "repo_id": "01J4ZB...",
    "task_id": "TASK-42",
    "attempt_id": "ATTEMPT-2",
    "machine_id": "01J7MACHINE...",
    "omp_session_id": "SESSION-93",
    "episode_id": "EPISODE-18",
    "spec_version": "4",
    "plan_version": "7",
    "commit": "abc1234",
    "evidence_id": "EV-72"
  }
}
```

`machine_id`는 memory visibility를 결정하는 tag가 아니라 provenance metadata로 사용한다. 다른 머신에서도 같은 기억을 사용해야 하기 때문이다.

Hindsight recall 결과에는 retain 시 입력한 metadata, tag, context, document ID와 시간 정보가 포함된다. ([Hindsight][5])

---

# 8. `document_id`를 적극적으로 사용한다

Hindsight의 document는 원본 출처를 추적하고, 같은 document ID를 다시 retain하여 내용을 대체할 수 있다. ([Hindsight][6])

이를 이용해 기억을 두 종류로 분리한다.

## A. Mutable document

현재 상태를 나타내는 요약이다.

```text
task/<task-id>/contract
task/<task-id>/current-summary
task/<task-id>/decisions/<decision-id>
repo/<repo-id>/build-guide
repo/<repo-id>/architecture/<topic>
```

예:

```ts
const documentId = `task/${taskId}/current-summary`;

await retain({
  documentId,
  content: taskSummary,
});
```

새 요약이 생기면 같은 ID로 다시 retain한다.

```text
기존 current-summary의 facts 삭제
→ 새 summary로 재추출
```

## B. Immutable event document

과거에 실제 발생한 사건이다.

```text
event/<event-id>
failure/<failure-id>
verification/<verification-id>
postmortem/<postmortem-id>
```

이들은 항상 새로운 document ID를 사용한다.

---

# 9. Hindsight에 넣는 payload

자유 대화 전체를 무조건 retain하지 않는다.

```ts
interface DurableMemoryRecord {
  kind:
    | "repo-fact"
    | "decision"
    | "failed-approach"
    | "successful-recipe"
    | "user-preference"
    | "postmortem";

  statement: string;
  rationale?: string;

  applicability: {
    repoId?: string;
    taskId?: string;
    commitRange?: string;
    conditions?: string[];
  };

  evidence: Array<{
    evidenceId: string;
    type: "test" | "log" | "diff" | "user-confirmation";
  }>;

  confidence: "confirmed" | "probable";
}
```

Hindsight에 보내는 text:

```text
Memory kind: failed-approach

Repository: project-x
Task: TASK-42

Attempt:
Adding retries only around token refresh did not fix the duplicate-token race.

Why it failed:
Both requests could still read the old token before either write committed.

Evidence:
The concurrency regression test failed 14 of 100 repetitions at commit abc123.

Applicability:
This applies to the current token-refresh implementation and should be
re-evaluated if the persistence model changes.
```

이렇게 해야 Hindsight가 의미와 인과관계를 더 정확하게 추출한다. Hindsight는 retain 시 사실, 시간, entity, relationship과 world/experience 구분을 추출하며, context가 화자를 해석하는 데 사용된다. ([Hindsight][7])

---

# 10. Hindsight Gateway 구현

OMP 기존 fetch client 위에 policy adapter를 둔다.

```text
기존 HindsightClient
└─ MemoryGateway
   ├─ bank resolver
   ├─ tag builder
   ├─ redact
   ├─ timeout/retry
   ├─ outbox
   ├─ dedup
   └─ recall merge
```

## 인터페이스

```ts
export interface MemoryGateway {
  health(): Promise<MemoryHealth>;

  recallForIntake(input: {
    userId: string;
    repoId: string;
    taskDraft: string;
  }): Promise<MemoryContext>;

  recallForPlanning(input: {
    repoId: string;
    taskId: string;
    goal: string;
    changedFiles?: string[];
  }): Promise<MemoryContext>;

  recallForRecovery(input: {
    repoId: string;
    taskId: string;
    attemptId: string;
    failure: string;
  }): Promise<MemoryContext>;

  retain(record: DurableMemoryRecord): Promise<void>;

  replaceCurrentTaskSummary(input: {
    repoId: string;
    taskId: string;
    summary: string;
  }): Promise<void>;

  flushOutbox(): Promise<void>;
}
```

## 설정

```yaml
hindsight:
  enabled: true
  baseUrl: http://127.0.0.1:8888
  apiToken: null

  timeout:
    recallMs: 2500
    retainMs: 5000
    reflectMs: 8000

  recall:
    taskTokens: 1800
    repoTokens: 1200
    userTokens: 600

  retain:
    mode: curated
    background: true
    rawTranscript: false

  failureMode:
    unreachable: degraded
    queueRetains: true
```

Hindsight는 recall read path를 빠르게 만들고 retain 과정에서 fact extraction을 수행하는 구조다. 문서상 recall은 일반적으로 retain보다 빠르고, 대량 retain은 background 또는 batch가 권장된다. 따라서 recall은 lifecycle gate에서 수행하고 retain은 로컬 outbox를 통해 비동기 처리하는 편이 적합하다. ([Hindsight][8])

---

# 11. 로컬 Hindsight Outbox

네트워크 라우팅이 설정되어 있어도 일시적으로 중앙 머신이나 Tailscale 연결이 끊길 수 있다.

Local Runtime DB:

```sql
CREATE TABLE memory_outbox (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE(bank_id, document_id, content_hash)
);
```

## 실행 방식

```text
retain 요청
  ↓
먼저 local outbox에 기록
  ↓
Hindsight 호출
  ├─ 성공 → delivered
  └─ 실패 → queued
```

같은 mutable document에 여러 업데이트가 대기 중이면 가장 최신 것만 전송한다.

```text
task/TASK-42/current-summary
├─ version 4 queued
├─ version 5 queued
└─ version 6 queued

→ version 6만 retain
```

---

# 12. Hindsight 장애 시 동작

Hindsight가 unavailable이라고 코딩 작업 전체를 막을 필요는 없다.

```text
Hindsight 정상
└─ memory-enabled mode

Hindsight 장애
├─ Registry/Git 기반 작업은 계속
├─ 새 retain은 outbox에 저장
├─ recall 없이 degraded context로 진행
├─ UI에 MEMORY DEGRADED 표시
└─ 중요한 재계획 전 사용자에게 알림
```

다만 다음 상황에서는 더 보수적으로 행동한다.

```text
cross-machine resume
과거 실패 전략 확인이 필요한 재계획
오래된 task 재개
큰 아키텍처 변경
```

이 경우 Hindsight recall 실패를 경고한다.

```text
과거 프로젝트 기억을 불러오지 못했습니다.
현재 Git 상태와 Task Registry만으로 계속 진행합니다.
```

---

# 13. 공용 Workflow Coordinator가 필요한 이유

Hindsight가 공용이므로 task 상태도 Hindsight에 저장하고 싶을 수 있지만, 그렇게 하면 안 된다.

Hindsight retain은 LLM 기반으로 입력을 fact로 추출하고 observation consolidation도 비동기로 진행한다. 이는 semantic memory에는 적합하지만 다음 연산에는 적합하지 않다.

```text
workspace lease 획득
plan version compare-and-swap
operation 상태 prepared → running → committed
episode heartbeat
중복 session 방지
transaction
```

Hindsight는 retain 후 observation을 비동기로 통합하고, recall은 의미·키워드·그래프·시간 기반 검색 결과를 반환한다. 즉 정확한 현재 행 상태를 보장하는 트랜잭션 DB가 아니다. ([Hindsight][5])

따라서 별도 `workflowd`를 만든다.

---

# 14. Workflow Coordinator 구현

## 권장 스택

```text
Bun
Bun.serve
SQLite (bun:sqlite)
HTTP
```

하나의 `workflowd` 프로세스만 SQLite 파일을 소유한다. 여러 머신은 SQLite 파일을 네트워크 파일시스템으로 직접 공유하지 않고, 동일한 `workflowd` HTTP API에 접속한다.

## API 예

```text
POST /v1/tasks
GET  /v1/tasks/:taskId
POST /v1/tasks/:taskId/attach-session
POST /v1/tasks/:taskId/specs
POST /v1/tasks/:taskId/attempts
POST /v1/episodes
POST /v1/episodes/:id/heartbeat
POST /v1/workspaces/:id/acquire
POST /v1/workspaces/:id/release
POST /v1/plans/:id/patch
POST /v1/checkpoints
POST /v1/verifications
GET  /v1/recovery/:taskId
```

모든 write에는 optimistic version을 넣는다.

```json
{
  "expectedVersion": 7,
  "patch": {
    "phase": "verifying"
  }
}
```

서버의 현재 version이 8이면 reject한다.

```json
{
  "error": "version_conflict",
  "currentVersion": 8
}
```

---

# 15. 머신 간 작업 이동

## 정상 handoff

머신 A:

```text
1. 새 operation 시작 중단
2. 테스트 또는 현재 상태 확인
3. WIP checkpoint commit
4. checkpoint remote에 push
5. Coordinator에 checkpoint 등록
6. deterministic handoff packet 저장
7. episode 종료
8. workspace lease 해제
```

머신 B:

```text
1. task 선택
2. 새 session + 새 episode 생성
3. attempt와 checkpoint 조회
4. checkpoint branch fetch
5. 새 worktree 생성
6. workspace snapshot 비교
7. Hindsight recall
8. plan 유효성 검사
9. 실행 재개
```

## Session 재개와 Task 재개를 구분

머신이 바뀌면 보통 이전 OMP session을 직접 resume하지 않는다.

```text
같은 머신 + session JSONL 존재
→ 기존 OMP session resume 가능

다른 머신
→ 새 OMP session
→ 같은 task/attempt attach
→ Coordinator handoff + Hindsight memory 주입
```

과거 transcript를 여러 머신에 복제하고 싶다면 별도 object store에 session JSONL을 업로드할 수 있지만, 작업 연속성에는 필수가 아니다.

---

# 16. 비정상 종료 후 다른 머신에서 복구

머신 A가 dirty worktree 상태에서 완전히 꺼졌다고 하자.

Coordinator:

```text
episode heartbeat timeout
→ episode = interrupted
→ workspace lease = expired
→ last shared checkpoint = CP-18
→ unshared local operations = unknown
```

머신 B에서:

```text
머신 A의 로컬 dirty state는 접근할 수 없음
```

따라서 선택지는 두 개다.

```text
A. 머신 A가 다시 온라인될 때까지 기다림
B. 마지막 remote checkpoint CP-18에서 재개
```

B를 선택하면:

```text
CP-18 이후 머신 A의 미공유 변경은 유실 가능
```

이를 UI에서 명시해야 한다.

```text
TASK-42는 머신 A에서 비정상 종료되었습니다.

마지막 공유 checkpoint: CP-18
미공유 작업 가능성: 있음

[CP-18에서 새 머신으로 복구]
[머신 A 복귀 대기]
[작업 중단]
```

Hindsight는 이 문제를 해결하지 못한다. Hindsight가 “어떤 코드를 수정했다”고 기억해도 실제 patch가 없으면 복원할 수 없기 때문이다.

---

# 17. Checkpoint remote

여러 머신을 쓸 생각이라면 WIP commit을 전송할 remote가 필요하다.

## 선택지

```text
1. 기존 origin의 전용 branch
2. 별도 private Git remote
3. Tailscale 내부 bare Git repository
```

권장 ref:

```text
refs/heads/agent/<task-id>/<attempt-id>
```

또는 hidden ref를 remote가 허용한다면:

```text
refs/agent/checkpoints/<task-id>/<attempt-id>/<checkpoint-id>
```

## Checkpoint 정책

```text
자동 checkpoint
├─ plan step 완료
├─ 검증 통과
├─ pause
├─ handoff
├─ compaction 전
└─ 위험 작업 전

선택적 push
├─ step 완료
├─ pause
├─ handoff
└─ 장시간 작업 중 일정 간격
```

매 tool call마다 push하면 지나치게 느리므로 local commit과 remote checkpoint를 구분한다.

---

# 18. Hindsight 호출 시점

## `conversation`

자동 recall하지 않는다. 일반적인 코드 질문에 매번 공유 기억을 넣으면 노이즈가 커진다.

사용자가 프로젝트 과거 맥락을 묻거나 명시적으로 recall을 요청할 때만 호출한다.

## `intake`

```text
사용자의 일반 선호 recall
저장소의 과거 설계 결정 recall
유사한 task recall
```

## `discovery`

```text
저장소 빌드·테스트 함정
과거 동일 오류
관련 모듈의 알려진 위험
```

## `planning`

```text
과거 성공 전략
실패한 접근
아키텍처 결정
사용자 제약
```

## `executing`

매 turn recall하지 않는다.

다음 이벤트에서만 호출한다.

```text
새로운 실패 발생
동일 실패 반복
계획 전략 변경
생소한 모듈로 이동
```

## `recovery`

반드시 recall한다.

```text
현재 task의 실패 경험
현재 attempt의 결정
저장소 일반 함정
```

## `completion`

검증된 정보만 retain한다.

```text
새로운 repo fact
최종 설계 결정
검증된 성공 recipe
실패 postmortem
```

`reflect`는 일반 tool loop마다 호출하지 않고 다음에 제한한다.

```text
planning
replanning
postmortem
오래된 task recovery
```

---

# 19. Memory injection 형식

Recall 결과를 그대로 모델 prompt에 넣지 않는다.

```xml
<memory-context source="hindsight" authoritative="false">
  <repo-memory>
    <fact evidence="memory:abc" confidence="high">
      The generated schema must be refreshed after modifying auth models.
    </fact>
  </repo-memory>

  <task-memory>
    <experience evidence="memory:def">
      Retry-only approach was tested and did not resolve the race.
    </experience>
  </task-memory>

  <user-preference>
    Prefer avoiding new runtime dependencies.
  </user-preference>
</memory-context>
```

중요한 문구:

```text
Hindsight memory is advisory historical context.
Current Git state, Task Registry, and verification evidence take precedence.
```

기억과 현재 상태가 충돌하면:

```text
Git/Registry/Evidence > Hindsight
```

---

# 20. 보안과 redaction

Hindsight가 여러 머신에서 공유되므로 retain 전 필터가 필요하다.

```text
저장 금지
├─ API key
├─ access token
├─ private key
├─ password
├─ .env 전체 내용
├─ 고객 PII
├─ 원본 secret-containing log
└─ credential-bearing shell command
```

## Redactor

```ts
interface MemoryRedactor {
  redact(content: string): {
    content: string;
    redactions: Array<{
      type: string;
      count: number;
    }>;
  };
}
```

Hindsight의 `receipt_uri`에 Evidence Store의 외부 증거 포인터를 넣을 수 있지만, Hindsight 안에는 원본 secret을 넣지 않는다. `receipt_uri`는 외부 provenance 포인터로 저장되는 필드다. ([Hindsight][7])

---

# 21. 수정된 설정 예

```yaml
agent:
  machineIdFile: ~/.config/omp-agent/machine-id

workflow:
  coordinatorUrl: http://127.0.0.1:8890

  heartbeat:
    intervalSeconds: 15
    staleAfterSeconds: 60

  workspace:
    leaseSeconds: 90
    mode: worktree

  checkpoint:
    remote: agent-state
    branchPrefix: agent
    pushOn:
      - pause
      - handoff
      - verified-step
      - before-compaction

hindsight:
  enabled: true
  baseUrl: http://127.0.0.1:8888

  integration:
    mode: workflow-managed
    exposeModelTools: false
    disableLegacyAutoRetain: true
    disableLegacyAutoRecall: true

  banks:
    user: omp-user-v1-${userId}
    repository: omp-repo-v1-${repositoryId}

  recall:
    intake: true
    planning: true
    recovery: true
    everyTurn: false

  retain:
    mode: curated
    background: true
    rawTranscript: false
    onlyVerifiedKnowledge: true

  outbox:
    enabled: true
    retryMax: 20

  degradedMode:
    allowExecution: true
    warnOnRecovery: true

  redaction:
    enabled: true
    scanSecrets: true
```

---

# 22. 구현 우선순위 변경

이 환경에서는 Hindsight 연동 자체보다 **멀티머신 공유 상태**를 먼저 구현해야 한다.

## Phase 1 — Hindsight Gateway 정리

* 기존 OMP Hindsight client 재사용
* `baseUrl = http://127.0.0.1:8888`
* 기존 auto-retain/recall 비활성화
* user/repo bank resolver
* tag·metadata builder
* local outbox
* redactor

## Phase 2 — Workflow Coordinator

* `workflowd`
* SQLite (`bun:sqlite`)
* task/spec/attempt/session/episode
* machine registry
* workspace lease
* heartbeat
* optimistic versioning

## Phase 3 — Cross-machine checkpoint

* worktree manager
* checkpoint commit
* checkpoint remote push/fetch
* handoff packet
* 다른 머신 resume

## Phase 4 — Operation Journal

* local SQLite
* prepared/running/applied
* crash reconciliation
* coordinator event outbox

## Phase 5 — Plan DAG 및 validation

* plan version
* invalidation
* verification evidence
* completion gate

## Phase 6 — Hindsight learning policy

* verified repo fact retain
* failed approach retain
* decision replacement
* postmortem reflect
* stale document update/delete

---

# 23. 가장 중요한 구현 원칙

```text
Hindsight는 공용이지만 authoritative하지 않다.

Task Registry는 공용이고 authoritative하다.

Git checkpoint는 코드 상태의 authoritative source다.

Local Runtime DB는 해당 머신의 in-flight 상태에 authoritative하다.

Session transcript는 대화 이력이지 작업 상태가 아니다.
```

최종 구조를 한 줄로 줄이면 다음과 같다.

```text
OMP session
  + local operation journal
  + shared workflow coordinator
  + Git checkpoint transport
  + shared Hindsight at localhost:8888
```

여기서 Hindsight의 역할은 명확하다.

> **여러 머신과 여러 세션에서 축적된 의미적 경험을 공유한다.**

반대로 Hindsight가 담당하지 않는 것은 다음이다.

> **현재 누가 작업하고 있는지, 어떤 코드가 실제로 존재하는지, 어떤 operation이 완료됐는지, 어디부터 복구해야 하는지 결정하는 것.**

이 구분을 유지해야 여러 머신 환경에서도 기억은 공유하면서 실행 상태는 일관되게 관리할 수 있다.

[1]: https://github.com/vectorize-io/hindsight "https://github.com/vectorize-io/hindsight"
[2]: https://github.com/can1357/oh-my-pi "https://github.com/can1357/oh-my-pi"
[3]: https://github.com/can1357/oh-my-pi/issues/1217 "https://github.com/can1357/oh-my-pi/issues/1217"
[4]: https://hindsight.vectorize.io/developer/api/memory-banks "https://hindsight.vectorize.io/developer/api/memory-banks"
[5]: https://hindsight.vectorize.io/developer/api/recall "https://hindsight.vectorize.io/developer/api/recall"
[6]: https://hindsight.vectorize.io/developer/api/documents "https://hindsight.vectorize.io/developer/api/documents"
[7]: https://hindsight.vectorize.io/developer/retain "https://hindsight.vectorize.io/developer/retain"
[8]: https://hindsight.vectorize.io/developer/performance "https://hindsight.vectorize.io/developer/performance"
