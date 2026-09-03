# Harness50 for Codex

Harness50의 Codex 어댑터는 원본 Claude Code 절차를 50개의 검증 가능한 단계로 실행하되, Codex의 정상 권한 확인과 명시적인 후크 신뢰 절차를 유지합니다. Claude Code 설치와 기존 동작은 [루트 안내서](../README.md)를 참고하세요.

## Host commands / 호스트 명령

| Host | Start | Status | Reset |
|---|---|---|---|
| Claude Code | `/webapp <topic>` | `/harness-status` | `/harness-reset` |
| Codex | `$webapp <topic>` | `$harness50-status` | `$harness50-reset` |

Codex does not provide a `/webapp` slash command. 진행 중인 Codex 워크플로를 이어가려면 `$webapp resume`, 자동 이어가기를 일시 정지하려면 `$webapp pause`를 사용하세요.

## Codex installation / 설치

### Local checkout (works before publication)

현재 브랜치의 Codex 지원을 확인하려면 저장소를 체크아웃한 뒤 그 루트를 로컬 마켓플레이스로 등록합니다.

```text
codex plugin marketplace add <path-to-harness50>
codex plugin add harness50@harness50
```

### GitHub source (only after publication)

이 브랜치의 변경이 원격 저장소에 게시된 뒤에는 다음 경로를 사용할 수 있습니다.

```text
codex plugin marketplace add Technoetic/harness50
codex plugin add harness50@harness50
```

The current upstream repository must not be assumed to include these Codex changes until they are published. 어느 경로를 사용하든 설치만으로 후크가 신뢰되지는 않습니다.

## Permissions and continuation / 권한과 이어가기

- Normal Codex permission confirmations remain in effect for every command.
- Harness50 never auto-approves commands and never changes sandbox or approval settings.
- Each later turn receives at most one 50-step continuation marker; that marker schedules work but grants no permission.
- Submitted command evidence is validated only as a string and exit status; the Harness50 runtime never executes that submitted command.
- The guard is a bounded, deny-only defense, not a shell sandbox; benign commands are never approved by the hook and still follow normal Codex permissions.

`$webapp`은 상태 관리자가 선택한 현재 단계 하나만 실행합니다. Stop 후크가 신뢰된 경우에만 다음 턴을 위한 단일 마커를 발급하며, 신뢰되지 않았거나 비활성인 경우 체인은 안전하게 멈춥니다.

## Migration and reset / 마이그레이션과 리셋

- Only when no Codex workflow exists, existing Claude progress may be imported read-only once.
- Codex never writes back to Claude progress and never merges later Claude changes.
- Reset archives and deactivates only Codex control metadata.
- Reset preserves Claude progress, TOPIC, shared outputs, project source, and application source.

가져온 Claude 완료 기록은 `imported`, Codex가 새로 검증한 완료 기록은 `codex_verified`로 구분됩니다. `$harness50-reset`은 복구 가능한 백업 경로를 보고하고 자동으로 새 워크플로를 시작하지 않습니다.

## Hook trust gate / 후크 신뢰 게이트

1. Start a fresh Codex session after installation and verify that all three skills are visible.
2. Open `/hooks` and inspect the exact installed `codex/hooks/hooks.json` definition and its four synchronous handlers: `PreToolUse`, `SessionStart`, `UserPromptSubmit`, and `Stop`.
3. Confirm that no approval hook is present, then manually trust only those exact current definitions.
4. Changed hook hashes require review and manual trust again; never bypass or automate this trust step.

확인할 세 스킬은 `$webapp`, `$harness50-status`, `$harness50-reset`입니다. Local installation stops at this trust gate until the user confirms the review. 이 확인 전에는 설치 자동화가 `$webapp`을 실행하거나 신뢰를 대신 처리해서는 안 됩니다.

## Host compatibility / 호스트 호환성

Claude Code behavior remains compatible, and the protected original 16 Claude files are unchanged. Codex 전용 코드는 [`codex/`](./) 아래에 격리되며 Claude의 슬래시 명령·후크 동작은 그대로 유지됩니다.

The full continuation lifecycle requires Codex CLI hooks; other hosts may discover the skills but must not claim continuation-hook support.

패키지 진입점은 [Codex manifest](../.codex-plugin/plugin.json), 신뢰 검토 대상은 [hook definition](hooks/hooks.json), 실행 절차는 [`skills/`](skills/)에서 확인할 수 있습니다.
