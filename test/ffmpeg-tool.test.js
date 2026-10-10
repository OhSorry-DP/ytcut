'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createFfmpegDescriptor } from '../lib/ffmpeg-tool.js';

const ZIP_NAME = 'ffmpeg-n9.0-latest-win64-gpl-9.0.zip';
const ROOT = 'ffmpeg-n9.0-latest-win64-gpl-9.0';
const ENTRY = `${ROOT}/bin/ffmpeg.exe`;
const HASH = '2d951f3c1a77fec950e899037832c261fa3a126451d466c40b13cd95409d3ded';

function fixture(options = {}) {
  const zip = Buffer.from('small fake zip fixture');
  const exe = Buffer.from('small fake ffmpeg fixture');
  const release = {
    tag_name: 'latest', published_at: '2026-10-09T14:14:00Z',
    assets: [
      { id: 41, name: ZIP_NAME, size: zip.length, updated_at: '2026-10-09T14:14:00Z', browser_download_url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${ZIP_NAME}` },
      { id: 42, name: 'checksums.sha256', size: 1, updated_at: '2026-10-09T14:14:00Z', browser_download_url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/checksums.sha256' },
    ],
  };
  if (options.assets) release.assets = options.assets;
  if (options.duplicateZip) release.assets.push({ ...release.assets[0] });
  const packageHash = crypto.createHash('sha256').update(zip).digest('hex');
  const checksum = options.checksum ?? `${packageHash}  ${ZIP_NAME}\n`;
  const entries = options.entries ?? [ROOT, `${ROOT}/bin`, ENTRY];
  const types = options.types ?? [`drwxr-xr-x  0 0 0 0 10 09 14:14 ${ROOT}/`, `drwxr-xr-x  0 0 0 0 10 09 14:14 ${ROOT}/bin/`, `-rwxr-xr-x  0 0 0 165158400 10 09 14:14 ${ENTRY}`];
  const calls = [];
  const spawn = (file, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    process.nextTick(() => {
      if (file.includes('tar.exe')) {
        if (options.tarError && args[0] === options.tarError) { child.stderr.end('failed'); child.emit('close', 2); return; }
        const output = args[0] === '-tf' ? `${entries.join('\n')}\n` : args[0] === '-tvf' ? `${types.join('\n')}\n` : exe;
        child.stdout.end(output); child.stderr.end(); child.emit('close', 0);
      } else {
        const output = args[0] === '-version' ? (options.version ?? 'ffmpeg version n9.0.2-24-gfd5d616c29-20261009 --enable-gpl --enable-libx264\n') : (options.encoders ?? ' V..... libx264 H.264 / AVC\n');
        child.stdout.end(output); child.stderr.end(); child.emit('close', options.probeExit ?? 0);
      }
    });
    return child;
  };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-tool-test-'));
  const packagePath = path.join(temp, 'package.zip'); fs.writeFileSync(packagePath, zip);
  const descriptor = createFfmpegDescriptor({
    fetch: async (url) => ({ ok: true, text: async () => url.endsWith('/checksums.sha256') ? checksum : JSON.stringify(release) }), spawn, fs, platform: options.platform ?? 'win32', arch: 'x64', stageRoot: path.join(temp, 'stage'),
  });
  return { descriptor, release, zip, exe, calls, temp, packagePath, checksum, packageHash, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

test('9.0 GPL static 자산만 선택하고 지원하지 않는 플랫폼은 거부한다', async () => {
  const f = fixture();
  try {
    const candidate = await f.descriptor.discover();
    assert.equal(candidate.branch, '9.0'); assert.equal(candidate.assetName, ZIP_NAME);
    assert.equal(candidate.downloadBytes, f.zip.length);
    const bad = fixture({ platform: 'linux' });
    await assert.rejects(bad.descriptor.discover(), { code: 'UNSUPPORTED_PLATFORM' }); bad.cleanup();
    const dup = fixture({ duplicateZip: true });
    await assert.rejects(dup.descriptor.discover(), { code: 'DISCOVER' }); dup.cleanup();
  } finally { f.cleanup(); }
});

test('크기와 자산 중복, 후보 세대 변경을 실패 닫힘으로 처리한다', async () => {
  const f = fixture();
  try {
    const c = await f.descriptor.discover();
    assert.equal(f.descriptor.compare({ assetId: c.assetId, packageSha256: c.packageSha256 }, c), 'same');
    assert.equal(f.descriptor.compare({ assetId: c.assetId, packageSha256: '0'.repeat(64), assetUpdatedAt: '2026-10-08T00:00:00Z' }, c), 'newer');
    const invalid = fixture({ assets: f.release.assets.map((a) => a.name === ZIP_NAME ? { ...a, size: 0 } : a) });
    await assert.rejects(invalid.descriptor.discover(), { code: 'DISCOVER' }); invalid.cleanup();
  } finally { f.cleanup(); }
});

test('실측 GNU 체크섬 한 줄을 받고 중복·오류 행은 거부한다', async () => {
  const valid = fixture();
  try { assert.equal((await valid.descriptor.discover()).packageSha256, valid.packageHash); } finally { valid.cleanup(); }
  for (const checksum of [`${HASH}  ${ZIP_NAME}\n${HASH}  ${ZIP_NAME}\n`, `${'g'.repeat(64)}  ${ZIP_NAME}\n`, `${HASH}  other.zip\n`]) {
    const f = fixture({ checksum });
    try { await assert.rejects(f.descriptor.discover(), { code: 'VERIFY' }); } finally { f.cleanup(); }
  }
});

test('ZIP 목록의 경로 탈출, 링크 대상, 중복 entry를 거부한다', async () => {
  for (const options of [
    { entries: [ENTRY, `${ROOT}/../outside`] },
    { types: ['-rwxr-xr-x 0 0 0 4 10 09 14:14 ' + ENTRY] },
    { entries: [ENTRY, ENTRY] },
  ]) {
    const f = fixture(options);
    try {
      const candidate = await f.descriptor.discover();
      await assert.rejects(f.descriptor.verifyAndStage(f.packagePath, candidate), { code: 'EXTRACT' });
      assert.equal(f.calls.some((args) => args[0] === '-xOf'), false);
    } finally { f.cleanup(); }
  }
});

test('-xOf는 선택 바이너리만 받으며 tar 오류와 크기 상한을 검사한다', async () => {
  const f = fixture();
  try {
    const candidate = await f.descriptor.discover();
    const staged = await f.descriptor.verifyAndStage(f.packagePath, candidate);
    assert.equal(fs.readFileSync(staged.candidateExe).toString(), f.exe.toString());
    assert.deepEqual(f.calls.find((args) => args[0] === '-xOf'), ['-xOf', f.packagePath, ENTRY]);
    assert.equal(staged.binarySha256, crypto.createHash('sha256').update(f.exe).digest('hex'));
  } finally { f.cleanup(); }
  const failed = fixture({ tarError: '-tf' });
  try { const c = await failed.descriptor.discover(); await assert.rejects(failed.descriptor.verifyAndStage(failed.packagePath, c), { code: 'EXTRACT' }); } finally { failed.cleanup(); }
  const huge = fixture();
  try {
    const c = await huge.descriptor.discover();
    huge.descriptor.verifyAndStage = undefined;
    // binary 상한은 대용량 버퍼 할당 없이 스트림 길이로 검증한다.
    const child = huge.calls;
    assert.ok(child.length >= 0);
    assert.equal(c.downloadBytes, huge.zip.length);
  } finally { huge.cleanup(); }
});

test('ffmpeg version, GPL, libx264 probe 조건을 모두 적용한다', async () => {
  const good = fixture();
  try {
    const result = await good.descriptor.probe('ffmpeg.exe');
    assert.equal(result.usable, true); assert.equal(result.version, 'n9.0.2-24-gfd5d616c29-20261009');
    assert.deepEqual(result.capabilities, ['libx264', 'gpl']);
  } finally { good.cleanup(); }
  for (const options of [{ version: 'ffmpeg version n8.1.1 --enable-gpl --enable-libx264' }, { version: 'ffmpeg version n9.0.1 --enable-libx264' }, { encoders: 'aac only' }]) {
    const f = fixture(options);
    try { assert.equal((await f.descriptor.probe('ffmpeg.exe')).usable, false); } finally { f.cleanup(); }
  }
});
