'use strict';

import path from 'node:path';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function normalizeYouTubeUrl(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypeError('YouTube URL must be a non-empty string');
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new TypeError('Invalid YouTube URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError('Unsupported URL protocol');
  }
  const authority = text.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/);
  const rawHost = authority && authority[1].slice(authority[1].lastIndexOf('@') + 1);
  if (parsed.username || parsed.password || parsed.port || (rawHost && rawHost.includes(':'))) {
    throw new TypeError('Credentials and ports are not allowed');
  }
  if (parsed.searchParams.has('list')) {
    throw new TypeError('Playlist URLs are not supported');
  }

  const host = parsed.hostname.toLowerCase();
  let id;
  if (host === 'youtu.be') {
    if (parsed.searchParams.has('list')) {
      throw new TypeError('Playlist URLs are not supported');
    }
    const match = parsed.pathname.match(/^\/([^/]+)\/?$/);
    id = match && match[1];
  } else if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
    if (parsed.pathname === '/watch') {
      id = parsed.searchParams.get('v');
    } else {
      const match = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)\/?$/);
      id = match && match[1];
    }
  }

  if (!id || !VIDEO_ID.test(id)) {
    throw new TypeError('Unsupported or invalid YouTube video URL');
  }

  return `https://www.youtube.com/watch?v=${id}`;
}

function buildMetadataArgs(url) {
  const canonicalUrl = normalizeYouTubeUrl(url);
  return [
    '--ignore-config', '--no-playlist', '--encoding', 'utf-8', '--skip-download', '-J', '--', canonicalUrl,
  ];
}

// yt-dlp 의 --ffmpeg-location 은 실제 경로만 받는다. PATH 명령 이름(구분자 없음)이면 생략해 yt-dlp 가 직접 찾게 한다.
function ffmpegLocationArgs(ffmpegPath) {
  return /[\\/]/.test(ffmpegPath) ? ['--ffmpeg-location', ffmpegPath] : [];
}

function buildDownloadArgs(item) {
  const format = item && item.snapshot && item.snapshot.format;
  let formatArgs;
  if (format === 'mkv') {
    formatArgs = ['-f', 'bv*+ba/b', '--merge-output-format', 'mkv'];
  } else if (format === 'mp4') {
    formatArgs = [
      '-f', 'bv[vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/b[vcodec^=avc1][acodec^=mp4a][ext=mp4]',
      '-S', 'vcodec:h264,acodec:aac', '--merge-output-format', 'mp4', '--remux-video', 'mp4',
    ];
  } else {
    throw new RangeError('snapshot.format must be "mkv" or "mp4"');
  }

  const canonicalUrl = normalizeYouTubeUrl(item.snapshot.video.url);
  const { outputDir, ffmpegPath } = item.execution;
  const { startSec, endSec } = item.snapshot.timeline;
  const mode = item.snapshot.cutMode;
  const section = `*${startSec.toFixed(3)}-${endSec.toFixed(3)}`;
  const modeFlag = mode === 'accurate' ? '--force-keyframes-at-cuts' : '--no-force-keyframes-at-cuts';
  const attemptDir = path.join(outputDir, item.id, `attempt-${item.attempt}`);

  return [
    '--ignore-config', '--no-playlist', '--encoding', 'utf-8', '--no-simulate', '--newline', '--progress',
    '--progress-delta', '0.25', '--progress-template', 'download:ytcut-progress:%(progress)j',
    '--progress-template', 'postprocess:ytcut-postprocess:%(progress)j', '--print',
    'after_move:ytcut-output:%(filepath)j', ...formatArgs, ...ffmpegLocationArgs(ffmpegPath),
    '--downloader-args', 'ffmpeg:-progress pipe:2 -stats_period 1 -nostats',
    '--download-sections', section, modeFlag, '-P', attemptDir, '-o', 'clip.%(ext)s', '--', canonicalUrl,
  ];
}

export { normalizeYouTubeUrl, buildMetadataArgs, buildDownloadArgs };
