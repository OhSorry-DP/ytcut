# 개발·검증·릴리즈 가이드

## 1. 실행과 테스트

```bash
npm install
npm test            # node --test (17개 파일 / 277개, skipped·todo 는 0 이어야 한다)
npm start           # electron .
```

- 🔴 **`ELECTRON_RUN_AS_NODE`**: VS Code 터미널·Claude Code 셸에는 이 변수가 `1` 로 켜져 있어 Electron 이 Node 로 실행돼 `import { app } from 'electron'` 이 깨진다(`does not provide an export named 'BrowserWindow'`). 항상 지우고 실행: bash `env -u ELECTRON_RUN_AS_NODE npm start`, PowerShell `$env:ELECTRON_RUN_AS_NODE=$null; npm start`.
- 개발 모드(`npm start`)에서는 앱 자동 업데이트가 꺼진다(`isPackaged` 아님).
- 외부 도구: `yt-dlp`·`ffmpeg` 가 PATH 에 있어야 한다(yt-dlp 는 없거나 오래되면 앱이 알아서 `userData/bin` 에 받는다).
- 2026-10-10 `npm test` 실행 결과: 277개 통과, 실패·취소·skipped·todo 모두 0. 부하 시 통합 테스트가 간헐적으로 실패했다는 기존 보고는 [handoff.md](handoff.md) 의 알려진 한계를 참고한다.

## 2. 단위 테스트의 한계와 "실제 앱 검증"

가짜(fake) 의존으로 도는 단위 테스트는 **아래를 전부 놓쳤다** — 반드시 실제 Electron 에서 확인한다.
- ESM/CJS 혼재(브라우저가 `lib/time.js` 를 import 하는데 CJS 라 깨짐), 모듈 간 계약 불일치(URL 정규화 함수가 문자열을 돌려주는데 main 은 객체로 가정), 최상위 `await app.whenReady()` 교착, GitHub 릴리즈 파일 호스트(`release-assets.githubusercontent.com`) 허용 목록 누락.

### 실제 앱 + CDP 검증 레시피
```bash
# 별도 Windows 테스트 계정에서 실행한다 (고정 userData는 --user-data-dir로 격리되지 않는다)
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe \
  --user-data-dir="<임시폴더>" --remote-debugging-port=9333 --remote-allow-origins='*' . &
```
- `http://127.0.0.1:9333/json` 에서 page 의 `webSocketDebuggerUrl` 로 접속(Node 24 전역 `WebSocket` 사용, 외부 라이브러리 불필요).
- `Runtime.evaluate` 로 DOM 조작·상태 조회, `Input.dispatchKeyEvent` 로 **진짜 키 입력**(단축키·iframe 포커스 검증), `Input.dispatchMouseEvent` 로 클릭, `Page.captureScreenshot` 으로 화면 확인(스크린샷을 직접 열어 눈으로 본다), `Emulation.setDeviceMetricsOverride` 로 창 크기 변경.
- 재생 검증: `<video>` 의 `webkitDecodedFrameCount`(프레임 디코딩)·`webkitAudioDecodedByteCount`(오디오 디코딩)로 실제 재생을 증명한다.
- 기본 창 스크롤: `document.documentElement.scrollHeight == clientHeight` (기본 창 콘텐츠 영역 ≈ 1184×811).
- 패키지 빌드 검증: `dist/win-unpacked/"Stream Cut.exe"` 에 같은 옵션을 준다. 0.5.0부터 userData가 고정되므로 별도 Windows 테스트 계정에서 실제 데이터 경로가 격리됐는지 먼저 확인한다.
- 검증용 영상: `jNQXAC9IVRw`(19초, 임베드 허용 — 가장 빠른 회귀용), `40tXXfoxqhI`(3시간 40분, **임베드 차단 → 대체 플레이어 재현용**, 사용자 제공), `dQw4w9WgXcQ`(이 환경에서 임베드 차단). 구간 다운로드 실측용으로는 짧은 구간(20~80초)만 받는다.
- 🔴 평가 스크립트 작성 팁: bash heredoc 안에서 따옴표가 꼬이면 **스크립트 전체가 시작도 못 하고 죽는다**(실제 겪음). 스크립트·지시서는 heredoc 대신 파일 쓰기 도구로 만든다. `Runtime.evaluate` 문자열 안의 `\\n`·복잡한 정규식 이스케이프는 `undefined` 를 반환하며 조용히 실패한다 — 단순하게 쓰고 결과가 `undefined` 면 스크립트 문제부터 의심.

## 3. 릴리즈 절차 (🔴 push·릴리즈는 사용자가 그 턴에 "푸시/배포/올려"라고 명시했을 때만)

1. `package.json` 의 `version` 을 올린다(자동 업데이트는 semver 비교). `docs/changelog.md` 의 「다음 버전(미출시)」 항목 제목을 새 버전으로 바꾼다(루트 README 에는 변경 이력을 쓰지 않는다). 설치·사용법이 바뀌었으면 `docs/user-guide.md` 도 갱신.
2. `npm test` 전부 통과 확인 → 로컬 커밋(한글 메시지, `Co-Authored-By` 줄 금지).
3. 빌드: `env -u ELECTRON_RUN_AS_NODE npm run dist` → `dist/` 에
   `StreamCut-<v>-win-x64.exe`(설치형) · `StreamCut-<v>-portable.exe` · `latest.yml` · `StreamCut-<v>-win-x64.exe.blockmap`.
   (아이콘: `package.json` 의 `build.win.icon`(`build/icon.ico`)을 exe·설치 파일에 넣으려면 `signAndEditExecutable:true` 여야 한다(`false` 면 리소스 편집이 통째로 건너뛰어져 기본 Electron 아이콘이 된다). 인증서가 없으므로 `forceCodeSigning:false`. 이 환경에서 winCodeSign 심볼릭 링크 문제 없이 빌드됨을 확인했다. 아이콘 원본은 `build/icon.svg`, 수정 후 `env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe build/make-icon.cjs build` 로 `icon.png`·`icon.ico` 를 다시 만든다. 코드 서명은 없다.)
4. 패키지 앱 확인: `dist/win-unpacked/"Stream Cut.exe"` 를 별도 Windows 테스트 계정에서 띄워 영상 로드·도구 인식·메뉴바 없음·스크롤 없음 확인.
5. `git push origin main` → `gh release create v<v> <설치형> <blockmap> <latest.yml> <포터블> --repo OhSorry-DP/streamcut --target main --title "Stream Cut <v>" --notes-file <노트>`.
   - 🔴 **`latest.yml` 과 `.blockmap` 을 반드시 같이 올린다**(없으면 자동 업데이트가 404).
   - 릴리즈 노트에 SHA-256(`sha256sum`)·업그레이드 안내·알려진 제한을 적는다.
   - `gh` 에는 계정이 둘 로그인돼 있다(`OhSorry-DP` 활성, `yenkara`). 저장소는 **OhSorry-DP**.
6. 릴리즈 직후 검증: 패키지 앱(이전 버전)의 `checkUpdate()` 가 새 버전을 보고하는지. ⚠️ 릴리즈를 만든 직후(수십 초)에는 GitHub 의 릴리즈 목록(atom 피드)이 아직 이전 릴리즈를 최신으로 보여 `latest.yml` 404(`UPDATE_FAILED`)가 날 수 있다 — 잠시 뒤 다시 확인.

## 4. 함정 모음 (전부 실제로 겪은 것)

| 함정 | 증상 | 대응 |
|---|---|---|
| 최상위 `await app.whenReady()` (ESM) | 창이 안 뜸, `ready` 안 옴 | `app.whenReady().then(...)` |
| `ELECTRON_RUN_AS_NODE=1` | Electron 이 Node 로 실행 | 변수 제거 |
| 한글 파일을 PowerShell/셸로 쓰기 | 한글이 물음표로 저장되어 UI 문구가 깨짐 | 파일 쓰기 도구·`apply_patch` 만 사용. 검증: 연속 물음표 줄 0(널 병합 연산자 제외)·U+FFFD 0 |
| 테스트 중 `taskkill //IM electron.exe` | **사용자가 켜 둔 앱까지 종료** | 내가 띄운 프로세스의 PID 만 종료. 별도 Windows 테스트 계정 사용 |
| 검증이 사용자 큐에 항목 추가 | 사용자의 실제 큐가 오염 | 별도 Windows 테스트 계정으로 고정 userData를 격리하고 출력 폴더도 임시로 지정 |
| `--ffmpeg-location ffmpeg`(명령 이름) | yt-dlp "does not exist" | 경로일 때만 인자 추가 |
| 영상 끝까지 재생 후 다운로드 | `playheadSec > durationSec` 검증 실패 | playhead 를 길이로 clamp |
| 미리보기 불가 영상에서 Space | 포커스된 다운로드 버튼이 눌려 중복 다운로드 | Space 는 영상 로드 여부와 무관하게 가로채기 |
| yt-dlp 업데이트 다운로드 | 처음엔 `NETWORK` 오류 | 허용 호스트에 `release-assets.githubusercontent.com` |
| electron-updater 를 Electron 밖에서 import | `app.getVersion` 접근 오류 | 주입형(`lib/updater.js`)으로 유지 |
| 같은 파일을 병렬 작업이 동시에 수정 | 덮어쓰기·충돌 | 병렬은 **파일이 안 겹칠 때만**(핫스팟: `renderer/app.js`, `index.html`, `style.css`, `test/integration.test.js`, `main.js`) |
| Windows 에서 실행 중인 exe 교체 | 잠금 실패 | yt-dlp 교체는 작업이 없을 때만 |
| `git worktree remove` 와 `node_modules` 정션 | 정션을 따라가 공유 대상 내용을 지울 수 있음 | 정션임을 확인한 뒤 해당 worktree 의 `node_modules` 정션을 `cmd /c rmdir "<worktree>\node_modules"` 로 먼저 분리한다. `/s` 는 사용하지 않는다 |
| Electron CDP 포트가 Windows 제외 포트 범위에 포함됨 | 디버그 포트 바인드 실패 | `netsh interface ipv4 show excludedportrange protocol=tcp` 로 확인하고 제외 범위 밖 다른 포트를 사용한다. 접속 URL 의 포트도 함께 바꾼다 |
| 0.3.0 이하 | 자동 업데이트 없음(`latest.yml`·`app-update.yml` 없이 빌드됨) | 0.4.0 은 직접 설치 1회 |

## 5. 작업 방식 (Claude + Sol/Luna)

사용자의 전역 규칙: Claude 는 요구 정리·검수·최종 판단, **Sol(`gpt-6.1-sol`)이 조사·설계·큰 구현, Luna(`gpt-6-luna`)가 작은 구현**. Claude 는 Luna 지시서를 직접 쓰지 않는다(Sol 이 씀). 로컬 Ollama 호출 금지. 병렬 가능한 건 병렬로, 조각별 로컬 커밋 후 합쳐서 검증.

호출: `cat <지시서.md> | "C:/Users/dc338/.claude/bin/codexw" exec -m gpt-6.1-sol --sandbox workspace-write --skip-git-repo-check -C "D:/util/ytcut" -o <출력.txt>` (`codexw` 가 계정 시트 폴백을 처리; 종료 시 `line 71 syntax error` 가 한 번 났지만 결과엔 영향 없었다).

이 프로젝트에서 효과가 있었던 지시서 구성:
- 맨 앞 금지 사항: 질문 금지, git add/commit/push 금지, 다른 codex 호출 금지, **앱/Electron 실행 금지(검증은 Claude 가 실제 화면에서)**, **한글이 든 텍스트는 `apply_patch` 로만**.
- 수정 허용 파일 화이트리스트(+ 병렬 중인 다른 조각의 파일은 "읽기만").
- 확정된 결정(재논의 금지), 병렬 조각 간 IPC 계약(채널명·페이로드·상태 객체 모양), 실측 사실(다시 조사하지 말 것).
- 검증 기준: 기존 테스트 수 이상 유지, `skipped`·`todo` 0, 한글 무결성(`?` 줄·U+FFFD), `index.html` id ⊇ `app.js`/`timeline-view.js` 가 참조하는 id.
- 보고 마지막에 「확신 없는 판단」 요구.

교훈:
- **워커의 "통과" 보고를 믿지 말고 Claude 가 `node --test` 와 실제 앱으로 재검증한다**(숫자·동작 모두). 모듈 간 계약 불일치는 지시서가 "다른 파일은 열지 마라"고 하면 워커가 추측으로 채운다 → 통합 정합 작업은 읽기 제한을 풀어 따로 시킨다.
- Luna 에게 "화이트리스트 파일"만 주면 파일이 없다고 보고하고 멈춘다 → 신규 생성 조각이면 지시서 맨 앞에 "아직 없는 것이 정상, apply_patch 로 새로 만들어라" 를 넣는다.
- 지시서는 세션 임시 폴더(scratchpad)에 있어 세션이 끝나면 사라진다 — 새 세션에서는 위 구성으로 다시 쓴다.
