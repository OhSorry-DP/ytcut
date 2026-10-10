# 아키텍처

## 1. 프로세스와 경계

```
main.js (Electron main, ESM)
 ├─ lib/server.js        loopback(127.0.0.1) 정적 서버 + /preview 스트림 라우트
 ├─ lib/jobs.js          다운로드 큐 스케줄러(단일 슬롯), lib/store.js 로 영속화
 │    └─ lib/runner.js   yt-dlp/ffmpeg 프로세스 실행(메타데이터·다운로드·취소)
 ├─ lib/updater.js       앱 자동 업데이트(electron-updater 래퍼, 주입형)
 ├─ lib/ytdlp-updater.js yt-dlp 호환 래퍼와 공통 관리 도구 엔진(주입형)
 ├─ lib/ffmpeg-tool.js  ffmpeg GPL 정적 릴리즈 탐색·검증·스테이징
 ├─ lib/tool-errors.js  관리 도구 오류 분류와 안전한 안내문
 └─ lib/preview-stream.js 대체 미리보기(스트림 URL 선택·ffmpeg 합성 스트리밍)
preload.cjs              window.ytcut 브리지(contextBridge, CommonJS 유일 예외)
renderer/ (http://127.0.0.1:<port>/renderer/index.html 로 로드)
 ├─ app.js               UI 전체 오케스트레이션(가장 큼)
 ├─ player.js            원본 임베드 플레이어(iframe) 래퍼
 ├─ local-player.js      MSE 대체 플레이어(fetch → MediaSource → SourceBuffer, player.js 와 같은 인터페이스)
 └─ timeline-view.js     타임라인 DOM·줌·핸들 드래그
lib/time.js, lib/timeline.js   순수 로직 — 브라우저가 HTTP 로 직접 import 하므로 반드시 ESM, DOM/Node 의존 금지
lib/queue-state.js, yt-args.js, progress.js   순수 로직(큐 검증·전이, argv 빌더, 진행률 파서)
```

- `package.json` 은 `"type": "module"` 이다. 모든 `lib/*.js`·`main.js`·`renderer/*.js` 는 ESM. `preload.cjs` 만 CommonJS(sandbox preload 제약).
- BrowserWindow: `contextIsolation:true, nodeIntegration:false, sandbox:true`. 메뉴바 제거(`Menu.setApplicationMenu(null)`), 기본 1200×850.
- renderer 는 `file://` 이 아니라 **loopback HTTP**(포트 0 = 임의 포트)로 로드한다. 이유: 임베드 플레이어는 HTTP Referer 가 없으면 error 153 을 낸다(file:// 불가).
- 서버는 Host 정확 검사, GET/HEAD 만, **정적 파일 allowlist**(`lib/server.js` 맨 위 표: renderer 6개 + `lib/time.js`·`lib/timeline.js`)와 `/preview/<32hex>.mp4` 만 서빙한다. 새 renderer 파일을 import 하려면 allowlist 에 추가해야 한다(안 하면 404).
- CSP: `default-src 'self'` 기반, `media-src 'self' blob:` 로 MSE 미디어를 허용한다(`lib/server.js:21`). `style-src 'self'` 이므로 HTML 의 `style="..."` 속성·`<style>` 태그·인라인 이벤트는 금지한다. JS 의 `element.style.x = ...` 는 허용된다. 새 DOM 은 `createElement/textContent`(사용자 제목에 `innerHTML` 금지).
- 단일 인스턴스 잠금(`requestSingleInstanceLock`). `app.whenReady().then(...)` 로 시작한다(**ESM 진입점에서 최상위 `await app.whenReady()` 를 쓰면 `ready` 가 영영 안 온다** — 실제로 겪은 사고).

## 2. 데이터 계약

### 영속 파일 (`app.getPath('userData')`)
- 표시 이름은 `Stream Cut`이지만 ready 전에 `%APPDATA%\YT Cut`으로 고정한다(`main.js`의 `app.setPath`, `lib/updater.js`의 `getLegacyUserDataPath`). 기존 설정·대기열과 관리 도구를 계속 읽으며 앱 식별자 `com.ohsorry.ytcut`도 유지한다.
- `state.json` — `{schemaVersion:1, revision, settings, items[]}`. 원자적 쓰기(tmp→rename), 단일 writer 직렬화, 손상 시 `state.corrupt-<ts>.json` 보존. 구버전 문서(새 필드 없음)는 그대로 로드돼야 한다(필드 추가는 항상 선택 필드로).
- `bin/yt-dlp.exe` — 앱이 관리하는 yt-dlp 사본(+ `.bak`, `.download` 임시 파일).
- `bin/ffmpeg.exe` — 앱이 관리하는 ffmpeg 실행 파일. 릴리즈 메타는 `ffmpeg.exe.meta.json` 및 백업 메타에 저장하고, 다운로드 ZIP·추출 후보는 격리 stage에서 처리한다. ffprobe.exe와 ffplay.exe는 추출하지 않는다.
- 기본 출력 폴더는 `app.getPath('videos')/ytcut` 이다(`main.js:25`). 신규 작업은 이 폴더 바로 아래에 `<파일명>.<확장자>` 를 저장한다. `execution.outputLayout` 없는 기존 작업은 `<큐 id>/attempt-<N>/clip.<확장자>` 중첩 경로를 유지한다.

### 설정 (`settings`)
`{ ytDlpPath:'yt-dlp', ffmpegPath:'ffmpeg', outputDir, cutMode:'accurate'|'fast', format:'mp4'|'mkv', autoUpdateYtDlp:true, autoUpdateFfmpeg:false, previewResolution:480, alwaysUseLocalPlayer:true }` — 기본 형식은 **mp4**. `autoUpdateFfmpeg`는 주기적 갱신 확인만 제어하며 관리본 사용과 최초 누락 설치를 끄지 않는다. `previewResolution`은 숫자 360/480/720, `alwaysUseLocalPlayer`는 boolean만 허용한다. 새 필드가 undefined인 경우만 기본값으로 채우고, main 초기화에서 누락된 필드들을 한 번 저장한다. 저장된 false는 보존하며 null 등 잘못된 존재 값은 `INVALID_SETTINGS`로 거부한다. schemaVersion 1과 기존 outputDir/format 마이그레이션은 유지하며 새 필드는 큐 snapshot/execution에 포함하지 않는다.

도구 경로는 기본 명령 이름일 때 관리본, 사용 가능한 PATH 순서로 탐지한다. 사용자 지정 경로는 그대로 사용하며 자동 설치·교체 대상이 아니다. 정상 관리본은 네트워크 장애만으로 PATH 버전으로 바꾸지 않는다. 관리본이 손상되거나 실행 불가이면 PATH를 탐지할 수 있지만 기존 파일은 삭제하지 않는다. PATH에서 ffmpeg를 쓸 수 있으면 최초 관리본 설치를 하지 않는다.

### 타임라인 상태 (`TimelineState`)
`{startSec, endSec, zoom(1..64), scrollSec, playheadSec}` — 단위는 **초**. `0 ≤ startSec < endSec ≤ durationSec`. 최소 길이 `min(0.05, duration)`. 좌표 변환·앵커 줌은 `lib/timeline.js`(`xToTime/timeToX/zoomAt/normalizeTimeline`).
주의: yt-dlp 의 `durationSec` 은 정수로 내림될 수 있어 끝까지 재생하면 플레이어 시간이 더 크다 → `playheadSec` 는 항상 영상 길이로 clamp.

### 큐 항목 (`QueueItem`)
```
{ id(UUID), attempt, status:'waiting'|'running'|'completed'|'failed'|'cancelled',
  phase:'queued'|'downloading'|'processing'|'done', progress(0..100 숫자), etaSec(선택),
  outputPath|null, fileDeleted(선택), fileName(선택), outputFileName(선택), missingOutputPath(선택),
  error:{code,message}|null, createdAt, updatedAt, startedAt, finishedAt,
  snapshot:{ video:{url,videoId,title,durationSec}, timeline:TimelineState, cutMode, format, fileName(선택) },
  execution:{ outputDir, ytDlpPath, ffmpegPath, outputLayout:'flat-v1'(선택) } }
```
- `snapshot` 과 `execution` 은 생성 후 불변이며 재시도도 같은 실행 설정을 사용한다. 신규 항목은 `snapshot.fileName` 과 항목의 `fileName` 에 확장자 없는 입력을 캡처하고 `execution.outputLayout:'flat-v1'` 을 설정한다(`lib/jobs.js:299`). 이름 변경은 `snapshot.fileName` 을 유지하고 항목의 `fileName` 을 바꾼다. 완료 항목은 `outputPath`·`outputFileName` 도 갱신한다. `outputFileName` 은 충돌 접미사·확장자를 포함한 실제 완료 파일명이다(`lib/jobs.js:85`, `lib/jobs.js:360`). 선택 필드가 없는 기존 큐도 복구한다(`lib/queue-state.js:138`).
- `normalizeFileName` 은 공백 제거·NFC 정규화 후 120자 제한, 금지 문자·예약 이름·확장자 등을 검증한다. 빈 입력은 제목을 치환·정제한 기본 이름을 사용한다(`lib/queue-state.js:7`, `lib/runner.js:148`).
- 완료 파일이 없어지면 `missingOutputPath` 에 원래 경로를 보존하고 `outputPath:null`, `fileDeleted:true` 로 저장한다. 그 경로에 일반 파일이 복구되면 되돌린다. 시작·창 포커스·큐 목록 호버 시 파일 시스템은 읽기 전용으로 확인하고 변경된 큐 상태만 저장한다(`lib/jobs.js:137`, `lib/jobs.js:156`, `main.js:237`, `renderer/app.js:705`).
- 전이: waiting→running/cancelled, running→completed/failed/cancelled, failed/cancelled→waiting(retry). completed 는 retry 불가. 앱 재시작 시 running→failed(`INTERRUPTED`), waiting 은 자동 재개.
- **원본 사이트 스트림 URL은 절대 큐·state.json·renderer 로 나가지 않는다**(main 메모리 전용).

## 3. IPC

모든 invoke 응답은 `{ok:true,value}` 또는 `{ok:false,error:{code,message}}`. 발신자 검증(메인 프레임 + 서버 origin) 후 처리. 원시 스택·stderr·URL 은 renderer 로 보내지 않는다.

| 채널 | 요청 | 설명 |
|---|---|---|
| `app:bootstrap` | – | `{settings, items, revision, tools:{ytDlp,ffmpeg}}` |
| `video:metadata` | `{url, requestId}` | `yt-dlp -J` → `{requestId, video}`. runner는 설정 상한으로 고른 streams와 raw formats를 함께 반환하고 main은 formats만 preview 캐시에 보관. URL/formats는 렌더러로 보내지 않으며 metadataCache는 Video만 저장 |
| `queue:add` / `cancel` / `retry` | snapshot / `{id}` | 저장 후 실행(persist-before-start) |
| `queue:open-output` / `open-file` | `{id}` | 폴더 열기 / 파일 열기 |
| `queue:delete-file` | `{id}` | 확인창 후 **휴지통**으로(`shell.trashItem`), flat 완료 항목은 검증된 최종 파일 하나, 기존 항목은 작업 폴더 대상 |
| `queue:rename` | `{id,fileName}` | 대기·실패·취소 항목의 이름 변경, 완료 항목은 디스크 개명 후 저장 성공 시 반영; 실행 중 거부 |
| `queue:refresh-files` | `{}` | 완료 파일의 삭제·복구 확인 |
| `queue:remove` | `{id}` | 목록에서만 제거(running 은 거부) |
| `settings:save` / `settings:choose-output` | 설정 / – | |
| `preview:prepare` | `{videoId}` | 대체 플레이어용 `{path:'/preview/<token>.mp4'}` |
| `ytdlp:state` / `ytdlp:check` | – | yt-dlp 자동 업데이트 상태 / 수동 확인 |
| `tools:state` | `{}` | `{revision,ytDlp,ffmpeg}` 공통 도구 상태 조회 |
| `tools:check` | `{toolId:'ytDlp'|'ffmpeg'}` | 해당 도구의 수동 확인. 확인만 수행하고 자동 다운로드하지 않음 |
| `tools:download` | `{toolId,candidateId,acknowledgedBytes}` | 현재 후보 ID와 UI에 표시한 바이트 크기가 일치할 때만 받기. 최초 설치도 화면 안내 확인 뒤 시작 |
| `update:state` / `check` / `download` / `install` | – | 앱 자동 업데이트 |
| push `queue:changed` | `{revision, items}` | 진행률은 250ms 로 합침 |
| push `tools:changed` | `{revision,ytDlp,ffmpeg}` | 큐 revision과 별도인 단조 증가 도구 revision |
| push `ytdlp:changed` / `update:changed` | 상태 객체 | 기존 호환 채널 유지 |

`preload.cjs` 가 노출하는 `window.ytcut` API에는 `toolsState, checkTool, downloadTool, onToolsChanged`를 포함한다. `bootstrap`은 기존 `tools:{ytDlp,ffmpeg}` 결과와 `toolStates`를 함께 반환한다. 기존 `ytdlpState/checkYtdlp/onYtdlpChanged` 및 앱 업데이트 브리지도 유지한다.

### 관리 도구 설치·오프라인 동작

ffmpeg는 BtbN/FFmpeg-Builds의 Windows x64 GPL 정적 빌드 중 `ffmpeg-n9.0-latest-win64-gpl-9.0.zip`만 후보로 인정한다. 자산 크기는 GitHub release metadata의 양의 safe integer를 사용하며 하드코딩하지 않는다. `checksums.sha256`에서 정확한 자산명과 일치하는 한 줄(64자리 hex, 공백 두 칸, 파일명)을 찾아 ZIP SHA-256을 확인한다. 실제 확인된 ZIP은 193,970,776바이트이고 SHA-256은 `2d951f3c1a77fec950e899037832c261fa3a126451d466c40b13cd95409d3ded`였지만, 이 실측값을 런타임 크기나 digest 상수로 쓰지 않는다.

Windows 내장 `tar.exe`로 목록과 타입을 확인하고 정확한 `<ffmpeg-n9.0-latest-win64-gpl-9.0>/bin/ffmpeg.exe`만 stage에 추출한다. 실행 전 버전·GPL·libx264를 확인한다. ffprobe.exe와 ffplay.exe는 추출하지 않는다. 실측한 첫 버전 줄은 `ffmpeg version n9.0.2-24-gfd5d616c29-20261009 ...`였고, Windows tar의 `-tvf` 출력은 파일 크기가 5번째 열, 날짜가 `10 09 14:14` 형식이었다.

도구 상태는 `{toolId,status,source,usable,revision,currentVersion,latestVersion,currentReleaseTag,candidateId,downloadBytes,downloadedBytes,percent,manual,needsInstall,canDownload,canRollback,error}` 계약을 따른다. `source`는 `managed/path/custom/none`, `error`는 `{code,message}`만 렌더러에 전달한다. URL, stderr, 로컬 경로, 민감정보는 상태에 넣지 않는다. 공통 gate는 yt-dlp·ffmpeg 교체와 큐 add/retry를 직렬화하며, 교체는 대기·실행 작업이 없고 미리보기 ffmpeg 프로세스의 종료가 확인된 뒤 진행한다. 큐가 복원된 상태에서 ffmpeg가 없으면 waiting 항목은 보존하고 설치를 미룬다. 도구가 준비되지 않았으면 새 add/retry는 `TOOL_NOT_READY`로 거부한다.

ffmpeg 주기 확인은 `autoUpdateFfmpeg:true`일 때만 시작 10초 뒤와 12시간마다 메타데이터를 조회하며, ZIP 받기는 별도 크기 확인과 사용자 동작이 필요하다. 수동 확인도 메타데이터만 조회한다. 자산 크기와 실제 수신 바이트가 달라지면 검증 실패로 처리한다. 설계 상한은 ZIP 512 MiB, 실행 파일 256 MiB, 체크섬 256 KiB, API JSON 2 MiB, ZIP 목록 1 MiB·4096항목이다. 네트워크 시간은 헤더 30초, body 무진행 30초, 전체 15분이며 UI 진행 알림은 250ms로 제한한다.

오프라인 또는 메타 조회·다운로드·검증 실패 시 정상 관리본과 기존 큐는 보존한다. 네트워크 오류를 이유로 정상 관리본을 PATH로 대체하지 않고, 실제 사용 가능한 도구의 `usable` 상태로만 작업 가능 여부를 판단한다. 최초 설치 실패는 세션에서 자동 반복하지 않으며 사용자 재시도 또는 경로 지정이 필요하다. 실패 분류는 `NETWORK`, `UPDATE_NOT_FOUND`, `RATE_LIMIT`, `VERIFY`, `EXTRACT`, `REPLACE_BUSY`, `REPLACE_RECOVERY_REQUIRED`를 포함한다. API 403만으로 원본/대상 사이트의 차단으로 단정하지 않는다.

GPL 정적 빌드에는 libx264가 포함된다. 배포 시 GPL 고지와 해당 바이너리에 대응하는 소스 제공 안내 및 공급자 릴리즈 링크를 제공해야 한다. 빌드 저장소 라이선스를 FFmpeg 바이너리 라이선스로 오인하지 않으며, 이 문서만으로 법적 의무 검토 완료를 뜻하지 않는다.

이름 변경은 디스크 개명에 실패하면 앱 이름도 유지한다. 큐 저장 실패 시 디스크 파일을 원위치로 복구하며, 복구도 실패하면 `RENAME_ROLLBACK_FAILED` 로 보고하고 저장 처리를 중단한다(`lib/jobs.js:321`). 한글 안내 매핑은 `main.js:73` 의 `RENAME_MESSAGES` 가 정본이다.

| 코드 | 안내 |
|---|---|
| `INVALID_FILE_NAME` | 파일명이 올바르지 않습니다. \ / : * ? " < > &#124; 문자와 확장자는 쓸 수 없고 120자 이하여야 합니다. |
| `OUTPUT_NAME_CONFLICT` | 같은 이름의 파일이 이미 있어 이름을 바꾸지 못했습니다. |
| `NOT_RENAMABLE` | 다운로드 중인 항목은 이름을 바꿀 수 없습니다. |
| `NO_OUTPUT_FILE` | 파일이 없어 이름을 바꿀 수 없습니다. |
| `INVALID_QUEUE_ID` | 대기열에서 항목을 찾지 못했습니다. |

## 4. 핵심 흐름

### 구간 다운로드 (`lib/yt-args.js` + `lib/runner.js`)
- argv 핵심: `--download-sections "*시작-끝"`(초, 소수 3자리) + 정확 모드 `--force-keyframes-at-cuts` / 빠른 모드 `--no-force-keyframes-at-cuts`.
- mkv: `-f bv*+ba/b --merge-output-format mkv`. mp4: `bv[vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/...` + `-S vcodec:h264,acodec:aac --merge-output-format mp4 --remux-video mp4` (**H.264/AAC 스트림이 없는 영상은 mp4 가 실패**한다 — 그땐 mkv).
- `--ffmpeg-location` 은 경로(`/`·`\` 포함)일 때만 넘긴다. `ffmpeg` 같은 PATH 명령 이름이면 생략(yt-dlp 가 "does not exist" 오류를 낸다).
- **진행률**: 구간 다운로드는 yt-dlp 가 ffmpeg 를 외부 다운로더로 써서 yt-dlp 자체 진행 이벤트가 마지막 한 번뿐이다. 그래서 `--downloader-args "ffmpeg:-progress pipe:2 -stats_period 1 -nostats"` 로 ffmpeg 가 stderr 에 1초마다 `out_time_us=` 를 내게 하고 `lib/progress.js` 가 파싱한다. percent = 처리 시각 ÷ 구간 길이(완료 전 99% 상한), ETA = 남은 시간 ÷ `speed=`. 이 key=value 줄은 오류 메시지용 stderr 버퍼에 넣지 않는다.
- 완료 판정: exit 0 + `after_move` 출력 경로 + 그 파일이 attempt 폴더 안에 실존. 취소는 `taskkill /PID /T /F` 로 자식(ffmpeg) 포함 종료.
- 신규 `flat-v1` 작업은 attempt 폴더에서 완성한 뒤 출력 폴더 바로 아래에 하드링크로 공개한다. 이름 충돌은 ` (2)`, ` (3)` 순서로 피하며, `EPERM`·`ENOTSUP`·`EXDEV`·`EINVAL` 이면 덮어쓰기 없는 복사로 폴백한다(`lib/runner.js:146`). 완료 후 검증된 `<UUID>` 임시 작업 폴더 정리를 시도한다. 정리 실패는 완료를 취소하지 않는다(`lib/runner.js:184`). 기존 중첩 레이아웃은 그대로 유지한다.

### 대체 플레이어와 폴백
1. bootstrap 완료를 기다린 뒤 edit마다 모드·해상도 상한을 캡처한다. 메타데이터 성공 후 기본 모드는 `createLocalPlayer`(local-player.js)를 직접 생성하며 성공 경로에서 원본 임베드 플레이어의 factory/API/iframe을 생성하지 않는다. 항상 사용을 끄면 임베드 플레이어(iframe)를 먼저 생성하고 오류 101/150/153에서 local로 한 번 전환한다. local 생성·준비·최종 재생 오류에서는 iframe으로 한 번 전환하며, iframe도 실패하면 미리보기만 비활성화한다. 로드별 시도 횟수·전환 promise와 generation/플레이어 소유권으로 중복 전환·왕복 루프·옛 콜백을 막는다. 오버레이는 메타데이터 → 선택 플레이어 준비 → 실제 load 완료 순서로 종료한다.
2. `preparePreview(videoId, previewResolution)` → `preview:prepare`는 숫자 360/480/720만 허용하며 생략 시 현재 settings 상한을 사용한다. `cacheFormats`는 `videoId → {formats, resolvedAt, revision}` 독립 복사 캐시이고 prepare마다 AVC/AAC 후보를 상한 이하 최고 높이/tbr 및 최고 abr로 재선택한다(원본 사이트의 HTTPS 미디어 호스트만). TTL 30분은 상한 변경으로 연장하지 않는다. 준비 entry는 `videoId:maxHeight`별 pending/URL/128비트 토큰이며 목록 갱신은 revision으로 다음 prepare 재사용을 막되 기존 토큰은 유지한다. 후보 없음·만료 시 `yt-dlp -g`로 재조회하고 serve 중 만료/URL 실패도 entry.maxHeight를 유지한다. muxed 폴백에도 AVC/AAC 제한을 적용하며 상한 이하 후보가 없으면 강제 다운스케일 대신 준비 실패를 보고한다. close는 캐시와 resolver를 정리한다.
3. `createRangeInputProxy` 는 ffmpeg 입력을 loopback URL 로 제공하고 원격 영상·오디오를 `RANGE_CHUNK = 10_000_000` 바이트 순차 Range 청크로 받는다(`lib/preview-stream.js:9`, `lib/preview-stream.js:20`, `lib/preview-stream.js:178`). 프록시 열기 실패 시에만 원격 직접 연결로 폴백한다. 열린 뒤의 오류는 직접 연결로 전환하지 않고 세션 오류 처리로 전달한다. 종료 경로에서는 프록시·ffmpeg 를 정리한다(`lib/preview-stream.js:357`, `lib/preview-stream.js:416`).
4. ffmpeg 는 두 입력을 fragmented MP4 로 합성한다(`libx264 ultrafast zerolatency crf30`, `-g 30 -keyint_min 30 -sc_threshold 0`, `aac 128k`, `frag_keyframe+empty_moov+default_base_moof`). 렌더러는 `/preview/<token>.mp4?start=<초>` 를 `fetch` 하고 초기 MP4 에서 코덱을 읽어 `MediaSource` 의 `SourceBuffer` 에 순차 추가한다. 한 영상의 MS/SB/blob URL은 범위 밖 이동에도 유지한다. 요청을 취소한 뒤 단일 작업 큐에서 진행 중 작업 완료 → `abort()` → append window 기본값 복원 → 3자리 반올림한 `start`를 `timestampOffset`에 설정 → 해당 응답의 init 재추가 → media 추가 순서로 처리한다. MIME 변경이나 실제 오류의 복구에서는 세션을 교체한다. 출력 스트림의 HTTP Range 와 입력 프록시의 Range 는 별개다.
5. 앞쪽 `FRONT_BUFFER_SEC=180`에서 읽기를 대기시키고 `RESUME_FRONT_SEC=170` 이하에서 재개한다. 현재 이동 목표가 있으면 목표 범위의 앞쪽 길이를 기준으로 한다. 비연속 범위 `MAX_RANGES=4` 또는 합계 `MAX_BUFFERED_SEC=720`을 넘을 때만 먼 범위부터 제거하며, 현재 시각과 최신 목표 각각의 `[t-60,t+10]`을 보호한다. 긴 범위는 양 끝을 최대 60초씩 제거하고, 실제 `sb.buffered`를 다시 조회한다. Quota에서는 상한 이내여도 후보 하나를 제거한 뒤 같은 bytes를 한 번 재시도한다. 보호 때문에 제거할 수 없으면 수신을 대기시킨다. 추가 단위 `SLICE_SIZE=256*1024`, 초기 데이터 한도 `INIT_LIMIT=1024*1024`, 폴링 `POLL_MS=250`, 이동 디바운스 `SEEK_MS=120`, 로딩 표시 지연 `BUFFERING_DELAY_MS=250`, 준비·수신 제한 및 복구 쿨다운 15000ms는 유지한다. 초·범위 상한은 메모리 바이트 상한을 보장하지 않는다.
6. `video.currentTime`, `video.buffered`, 공개 시각은 모두 원본 절대 초이며 `actual()`은 영상 길이로 제한한다. `getTime()`은 끝에서는 영상 길이, 그 외에는 `pendingTarget ?? target ?? actual()`을 반환한다. 재생 가능 여부는 매번 `video.buffered`로 확인한다. A→B→A에서 A가 남아 있으면 fetch 없이 즉시 이동하며, 범위 밖 이동만 120ms 후 새 요청을 시작한다. 수신 EOF는 요청만 종료하고 MS를 open으로 유지하며 `endOfStream()`을 호출하지 않는다. 끝은 실제 시각이 `duration-0.1` 이상이거나 명시적으로 영상 끝을 seek할 때 판정하고 캐시는 보존한다. 재생 의사가 있고 현재 범위 앞쪽이 10초 이하이면 범위 끝부터 보충하되 현재 시각이나 재생 의사를 바꾸지 않는다. 1단계에서는 뒤쪽 기존 범위와 겹쳐 받아도 되며, 이음매 중단·repair·gap 자동 이동은 적용하지 않는다.
7. 사용자 제공 기존 실측(40tXXfoxqhI): 처음 로드 약 4.1초(이전 9.1초), 버퍼 안 ±10초 약 0.04초, 재생 4초 후 앞쪽 버퍼 약 183초, 범위 밖 이동 0.8~2.4초(이전 4~5초). 입력 단일 연결은 실시간 약 2배속으로 제한되었지만 10MB Range 청크는 수십 MB/s 였다. 직접 `<video src>` 방식은 정지 상태에서도 앞쪽 약 2.3초만 수신했고 서버 스트림 자체는 초당 약 10MB 로 충분히 빨랐다. 수치는 코드 보장값이 아니며 이번 문서 갱신에서 재측정하지 않았다. 실패한 접근은 [handoff.md](handoff.md) 에 기록한다.

### 단축키 (`renderer/app.js` 의 전역 keydown/keyup, capture 단계)
Space 재생/정지, ←/→ ±10초, Shift+←/→ ±60초, Ctrl+←/→ ±1초(Ctrl 이 Shift 보다 우선), [ 다운로드 버튼과 동일(반복 입력 무시), I/O 현재 시각을 시작/끝으로, P 시작점부터 미리 재생(끝점에서 자동 정지; 직접 이동하면 해제). 텍스트 입력·select 에서는 무시, **설정 모달이 열려 있는 동안 무시**. Space 는 keydown/keyup 모두 `preventDefault`(포커스된 버튼이 눌려 다운로드가 중복되는 사고 방지 — 미리보기 불가 영상에서도 동일). 임베드 플레이어(iframe)를 클릭해 포커스가 가면 부모 문서로 되돌린다. 영상이 시작 전(UNSTARTED/CUED)이면 이동 전에 재생을 먼저 시작(`player.seek`).

### 자동 업데이트 (두 종류, 서로 독립)
- **앱**(`lib/updater.js`): `autoDownload=false`, 설치형(NSIS)만 전체 자동. 시작 5초 뒤 + 6시간마다 확인. 알림 배너 → 사용자가 다운로드 → 「재시작하여 설치」. 포터블·개발 모드는 릴리즈 페이지 열기. 진행 중 다운로드 작업이 있으면 설치 전 확인창, 정리(`jobs.shutdown`) 후 `quitAndInstall`. 피드는 `build.publish`(github, OhSorry-DP/streamcut) → `latest.yml` 에서 읽는다. 외부 브라우저로 여는 페이지는 원격 응답이 아닌 `RELEASE_URL` 상수이며 새 저장소의 릴리즈 접두사만 허용한다.
- **yt-dlp**(`lib/ytdlp-updater.js`): 효과 경로 = 기본 경로(`'yt-dlp'`)면 관리 사본(있으면) 아니면 PATH, 사용자 지정 경로면 건드리지 않음. 최신 릴리즈 태그가 현재 `--version` 보다 클 때만 받는다. `SHA2-256SUMS` 로 SHA-256 검증 → 받은 파일 `--version` 확인 → **작업 중이 아닐 때만** 교체(`.bak` 보관). 허용 호스트: `github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com`(GitHub 가 릴리즈 파일을 `release-assets…` 로 리다이렉트하는데 처음엔 허용 목록에 빠져 실환경에서 실패했다). 시작 10초 뒤 + 12시간마다.

## 5. UI 구성 요약

- 왼쪽 메인: URL 입력 → 제목 → 플레이어(남는 높이를 차지, 16:9) → 타임라인(높이 약 64px) → 컨트롤(시작/끝 입력, 시작·끝 지정, 미리보기, 확대, 형식, 자르기 모드, 다운로드). 오른쪽 사이드패널: 다운로드 대기열(리스트형, 최신이 위, 행 호버 시 아이콘 버튼). **기본 창에서 세로 스크롤이 없어야 한다**(`documentElement.scrollHeight == clientHeight`).
- 설정은 헤더 톱니 버튼 → 네이티브 `<dialog>` 2단 모달(왼쪽 범주 일반/도구/앱 업데이트, 오른쪽 항목, 크기 720×540 고정에 가깝게). 저장은 모든 범주를 한 번에.
- 알림 배너(`#update-banner`)는 앱 맨 위, 로딩 오버레이(`#loading-overlay`)는 플레이어 위, `#fallback-badge` 는 대체 플레이어 사용 중 표시.
- 다크 테마, 색은 `:root` CSS 변수 한 곳.

## 6. 보안 결정(바꾸지 말 것)
- 임의 URL·경로를 IPC 로 받지 않는다(videoId 는 `^[A-Za-z0-9_-]{11}$`, 토큰 `^[0-9a-f]{32}$`, start 는 검증된 숫자 문자열만 ffmpeg 인자로).
- 사용자 입력·제목·URL 을 셸 문자열에 넣지 않는다(`shell:false`). 임시 출력은 `clip.<ext>` 를 사용하고, 최종 파일명은 검증·정제한 이름과 형식 확장자로 구성한다(`lib/runner.js:148`).
- 파일 삭제는 휴지통으로 보낸다. flat 완료 항목은 출력 폴더 바로 아래의 검증된 일반 파일 하나만, 기존 중첩 항목은 검증된 `outputDir/<UUID>` 폴더만 대상으로 한다(`lib/jobs.js:239`).
- PATH 의 yt-dlp 는 절대 수정·삭제하지 않는다.
