# Stream Cut 문서

영상 주소(URL)를 입력하면 yt-dlp 로 영상을 가져와 원하는 구간만 잘라 저장하는 Windows Electron 앱. (저장소: https://github.com/OhSorry-DP/streamcut, 공개)

## 문서 목록

| 문서 | 내용 | 언제 읽나 |
|---|---|---|
| [user-guide.md](user-guide.md) | 설치, 사용법, 요구 사항 | 앱을 쓰거나 설명할 때 |
| [changelog.md](changelog.md) | 버전별 변경 이력(**커밋할 때 여기에 항목 추가**) | 무엇이 바뀌었는지 볼 때 |
| [handoff.md](handoff.md) | **현재 상태, 미완료 작업, 결정 이력, 사용자 선호** | 새 세션을 시작할 때 가장 먼저 |
| [architecture.md](architecture.md) | 프로세스 구조, 모듈 표, 데이터 계약, IPC 목록, 핵심 흐름 | 코드를 고치기 전에 |
| [dev-guide.md](dev-guide.md) | 실행·테스트·실제 앱 검증 방법, 빌드·릴리즈 절차, 함정 모음 | 검증하거나 배포할 때 |

저장소 루트의 `README.md` 는 프로그램 설명과 링크만 둔다. 설치·사용법·변경 이력·구조 설명은 모두 이 폴더에 있다.

## 한 줄 요약

- 영상 URL → 앱 안 원본 임베드 플레이어(iframe) → 확대/스크롤 되는 타임라인에서 시작/끝 선택 → 다운로드 대기열에 추가 → `yt-dlp` + `ffmpeg` 가 구간만 받아 MP4/MKV 로 저장.
- 영상 소유자가 임베드를 막은 영상(임베드 오류 150/101/153)은 ffmpeg 로 영상+오디오를 합친 대체 플레이어(미리보기 해상도 360/480/720p 선택, 기본 480p)로 자동 전환하며, 기본 설정에서는 모든 영상을 대체 플레이어로 미리본다.
- 앱 자동 업데이트(GitHub 릴리즈, electron-updater)와 yt-dlp 자동 업데이트(앱 데이터 폴더에 최신 `yt-dlp.exe` 보관) 내장.

## 기술 스택 (2026-10-10 기준)

- Electron 44.7.0, 번들러·프레임워크 없는 순수 HTML/CSS/ESM JS (TypeScript·React 사용 안 함)
- 런타임 의존성: `electron-updater` 6.8.9 하나. 개발 의존성: `electron`, `electron-builder` 26.15.3
- 테스트: Node 내장 `node --test` (17개 파일, 160개), 외부 테스트 프레임워크 없음
- 외부 도구: `yt-dlp`(자동 업데이트됨), `ffmpeg`(사용자가 PATH 에 설치)
