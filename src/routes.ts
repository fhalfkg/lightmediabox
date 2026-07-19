import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import cp from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import db from './db';
import crypto from 'crypto';
import { VideoRecord } from './types';
import { getConfig, saveConfig } from './config';
import { startScanner, stopScanner } from './scanner';

const router = express.Router();
const HLS_TEMP_DIR = path.resolve(process.cwd(), 'hls_temp');
const SEGMENT_TIME = 10;

if (!fs.existsSync(HLS_TEMP_DIR)) fs.mkdirSync(HLS_TEMP_DIR, { recursive: true });

// ⚡ 화질별 독립 스트림 관리: 키 = "${videoId}_${quality}"
const activeStreams: Record<string, { 
    command?: ffmpeg.FfmpegCommand; 
    timeout?: NodeJS.Timeout; 
    currentSeq?: number; 
    startTime?: number;
}> = {};
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

const getStreamKey = (id: string, quality: string) => `${id}_${quality}`;

const cleanupStream = (id: string, quality?: string) => {
    if (quality) {
        // 특정 화질만 정리
        const key = getStreamKey(id, quality);
        const stream = activeStreams[key];
        if (stream) {
            if (stream.command) stream.command.kill('SIGKILL');
            clearTimeout(stream.timeout);
            delete activeStreams[key];
        }
        const outDir = path.join(HLS_TEMP_DIR, id.toString(), quality);
        if (fs.existsSync(outDir)) {
            fs.rmSync(outDir, { recursive: true, force: true });
            console.log(`🗑️ [ID: ${id}] ${quality} 임시 HLS 파일 정리 완료`);
        }
    } else {
        // 해당 비디오의 모든 화질 정리
        for (const key of Object.keys(activeStreams)) {
            if (key.startsWith(`${id}_`)) {
                const stream = activeStreams[key];
                if (stream.command) stream.command.kill('SIGKILL');
                clearTimeout(stream.timeout);
                delete activeStreams[key];
            }
        }
        const outDir = path.join(HLS_TEMP_DIR, id.toString());
        if (fs.existsSync(outDir)) {
            fs.rmSync(outDir, { recursive: true, force: true });
            console.log(`🗑️ [ID: ${id}] 임시 HLS 파일 전체 정리 완료`);
        }
    }
};

// 원본 해상도를 분석하여 제공할 화질 목록을 계산하는 헬퍼 함수
const getAvailableQualities = (resolution: string | null) => {
    const [w, h] = resolution ? resolution.split('x').map(Number) : [1920, 1080];
    const originalHeight = isNaN(h) ? 1080 : h;
    const originalWidth = isNaN(w) ? 1920 : w;

    const qualities = [{ name: 'original', label: `원본 (${originalHeight}p)`, height: originalHeight, width: originalWidth }];
    if (originalHeight > 1080) qualities.push({ name: '1080p', label: '1080p', height: 1080, width: 0 });
    if (originalHeight > 720) qualities.push({ name: '720p', label: '720p', height: 720, width: 0 });
    if (originalHeight > 480) qualities.push({ name: '480p', label: '480p', height: 480, width: 0 });

    return qualities;
};

// ─── 설정 API ───
router.get('/config', (req, res) => {
    res.json(getConfig());
});

router.post('/config', async (req, res) => {
    const { mediaDir } = req.body;
    if (!mediaDir) return res.status(400).json({ error: '경로가 필요합니다.' });

    try {
        const resolvedPath = path.resolve(mediaDir);
        if (!fs.existsSync(resolvedPath)) {
            fs.mkdirSync(resolvedPath, { recursive: true });
        }
        await stopScanner();
        saveConfig({ mediaDir: resolvedPath });
        db.prepare('DELETE FROM videos').run();
        const THUMBNAIL_DIR = path.resolve(process.cwd(), 'public/thumbnails');
        if (fs.existsSync(THUMBNAIL_DIR)) {
            fs.readdirSync(THUMBNAIL_DIR).forEach(file => {
                const curPath = path.join(THUMBNAIL_DIR, file);
                fs.rmSync(curPath, { recursive: true, force: true });
            });
        }
        startScanner();
        res.json({ success: true, mediaDir: resolvedPath });
    } catch (err: any) {
        console.error('경로 변경 오류:', err);
        res.status(500).json({ error: '경로 변경 중 오류가 발생했습니다.', details: err.message });
    }
});

// ⚡ 시스템 폴더 브라우징 API (설정 모달용)
router.get('/system-browse', (req, res) => {
    let targetPath = (req.query.path as string) || '';

    try {
        if (!targetPath) {
            if (os.platform() === 'win32') {
                let drives = ['C:'];
                try {
                    const stdout = cp.execSync('wmic logicaldisk get name', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
                    const matched = stdout.match(/[A-Z]:/g);
                    if (matched) drives = matched;
                } catch (e) {
                    // wmic 오류 발생 시 기본 드라이브(C:)로 폴백
                }
                const folders = drives.map(d => ({
                    name: d + '\\',
                    path: d + '\\'
                }));
                return res.json({ currentPath: '', parentPath: null, folders });
            } else {
                // 리눅스/Mac의 경우 빈 경로일 때 홈 디렉토리부터 시작
                targetPath = os.homedir();
            }
        }

        const resolvedPath = path.resolve(targetPath);
        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
            return res.status(404).json({ error: '경로를 찾을 수 없습니다.' });
        }

        const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
        const folders = entries
            .filter(e => e.isDirectory() && !e.name.startsWith('$') && !e.name.startsWith('System Volume Information'))
            .map(e => ({
                name: e.name,
                path: path.join(resolvedPath, e.name)
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        const parsed = path.parse(resolvedPath);
        const parentPath = (parsed.root === resolvedPath) ? '' : path.resolve(resolvedPath, '..');

        res.json({
            currentPath: resolvedPath,
            parentPath,
            folders
        });
    } catch (err: any) {
        console.error('System browse error:', err);
        // 권한 오류 등의 경우 빈 목록 반환
        res.json({
            currentPath: targetPath,
            parentPath: path.resolve(targetPath, '..'),
            folders: []
        });
    }
});

// ─── API 라우터 ───

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.webm'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS];

router.get('/videos', (req, res) => {
    const videos: any[] = db.prepare('SELECT * FROM videos ORDER BY id DESC').all();
    videos.forEach(video => {
        const hash = crypto.createHash('md5').update(video.id.toString()).digest('hex');
        const folderName = hash.substring(0, 2);
        video.thumbnail_url = `/thumbnails/${folderName}/${hash}.jpg`;
    });
    res.json(videos);
});

// ⚡ 폴더 브라우징 API
router.get('/browse', (req, res) => {
    const relativePath = (req.query.path as string) || '';
    const { mediaDir } = getConfig();

    // 경로 탐색 공격 방지
    const normalizedPath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
    const targetDir = path.resolve(mediaDir, normalizedPath);

    if (!targetDir.startsWith(mediaDir)) {
        return res.status(403).json({ error: '접근 권한이 없습니다.' });
    }

    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        return res.status(404).json({ error: '폴더를 찾을 수 없습니다.' });
    }

    try {
        const entries = fs.readdirSync(targetDir, { withFileTypes: true });

        // 폴더 목록
        const folders = entries
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .map(e => {
                const folderPath = relativePath ? `${relativePath}/${e.name}` : e.name;
                const absoluteFolderPath = path.join(targetDir, e.name);
                
                // 해당 폴더(하위 포함) 내의 랜덤 비디오 1개 선택
                // LIKE 패턴을 위해 폴더 경로 끝에 구분자와 % 추가
                const pattern = absoluteFolderPath + path.sep + '%';
                const randomVideo = db.prepare('SELECT id FROM videos WHERE file_path LIKE ? ORDER BY RANDOM() LIMIT 1').get(pattern) as { id: number } | undefined;
                
                const typeCounts = db.prepare('SELECT type, COUNT(*) as count FROM videos WHERE file_path LIKE ? GROUP BY type').all(pattern) as { type: string, count: number }[];
                let videoCount = 0;
                let imageCount = 0;
                typeCounts.forEach(r => {
                    if (r.type === 'video') videoCount = r.count;
                    if (r.type === 'image') imageCount = r.count;
                });
                
                let thumbnail_url = undefined;
                if (randomVideo) {
                    const hash = crypto.createHash('md5').update(randomVideo.id.toString()).digest('hex');
                    const hashFolder = hash.substring(0, 2);
                    thumbnail_url = `/thumbnails/${hashFolder}/${hash}.jpg`;
                }

                return {
                    name: e.name,
                    path: folderPath,
                    thumbnail_url,
                    videoCount,
                    imageCount
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));

        // 현재 폴더 내 미디어 파일 (DB에서 조회)
        const videos: any[] = [];
        entries
            .filter(e => e.isFile() && MEDIA_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
            .forEach(e => {
                const fullPath = path.join(targetDir, e.name);
                const video = db.prepare('SELECT * FROM videos WHERE file_path = ?').get(fullPath) as VideoRecord | undefined;
                if (video) {
                    // 해싱 로직 적용하여 프론트엔드용 썸네일 URL 주입
                    const hash = crypto.createHash('md5').update(video.id.toString()).digest('hex');
                    const folderName = hash.substring(0, 2);
                    video.thumbnail_url = `/thumbnails/${folderName}/${hash}.jpg`;
                    videos.push(video);
                }
            });

        // 파일명 기준 정렬
        videos.sort((a: any, b: any) => a.file_name.localeCompare(b.file_name));

        res.json({
            currentPath: relativePath,
            parentPath: relativePath ? path.dirname(relativePath).replace(/^\./, '') : null,
            folders,
            videos,
        });
    } catch (err) {
        console.error('폴더 탐색 오류:', err);
        res.status(500).json({ error: '폴더 탐색 중 오류가 발생했습니다.' });
    }
});

// ⚡ 이미지 원본 제공 API
router.get('/image/:id', (req, res) => {
    const { id } = req.params;
    const media: any = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
    if (!media || !fs.existsSync(media.file_path) || media.type !== 'image') {
        return res.status(404).send('이미지를 찾을 수 없습니다.');
    }
    res.sendFile(media.file_path);
});

// ⚡ 화질 목록 API (프론트엔드 화질 메뉴에 사용)
router.get('/hls/:id/qualities', (req, res) => {
    const { id } = req.params;
    const video: any = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
    if (!video) return res.status(404).json({ error: '비디오를 찾을 수 없습니다.' });

    const qualities = getAvailableQualities(video.resolution);
    
    // MP4/WebM 컨테이너에 H.264/AAC 코덱인 경우 Direct Play (TS 변환 없는 원본 스트리밍) 지원 여부 판별
    // ffprobe는 컨테이너 포맷을 'mov,mp4,m4a,3gp,3g2,mj2' 형식으로 반환하므로 includes를 사용합니다.
    const isDirectPlaySupported = 
        (video.container_format.includes('mp4') || video.container_format.includes('webm') || video.container_format.includes('mov')) &&
        video.video_codec === 'h264' &&
        video.audio_codec === 'aac';

    res.json({ qualities, isDirectPlaySupported });
});

// ⚡ Direct Play 스트리밍 API (HTTP Range 206 지원)
router.get('/video/:id/direct', (req, res) => {
    const { id } = req.params;
    const video: any = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
    if (!video || !fs.existsSync(video.file_path)) return res.status(404).send('비디오를 찾을 수 없습니다.');

    const stat = fs.statSync(video.file_path);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(video.file_path, { start, end });
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        const head = {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(200, head);
        fs.createReadStream(video.file_path).pipe(res);
    }
});

// 화질별 HLS 플레이리스트
router.get('/hls/:id/:quality/index.m3u8', (req, res) => {
    const { id, quality } = req.params;
    const video: any = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
    if (!video || !video.duration) return res.status(404).send('비디오를 찾을 수 없습니다.');

    // 화질별 독립된 임시 폴더 생성
    const outDir = path.join(HLS_TEMP_DIR, id.toString(), quality);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    // 타임아웃 갱신
    const streamKey = getStreamKey(id, quality);
    if (!activeStreams[streamKey]) activeStreams[streamKey] = {};
    if (activeStreams[streamKey].timeout) clearTimeout(activeStreams[streamKey].timeout);
    activeStreams[streamKey].timeout = setTimeout(() => cleanupStream(id, quality), SESSION_TIMEOUT_MS);

    const totalSegments = Math.ceil(video.duration / SEGMENT_TIME);
    let m3u8 = "#EXTM3U\n#EXT-X-VERSION:3\n";
    m3u8 += `#EXT-X-TARGETDURATION:${SEGMENT_TIME}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n`;

    for (let i = 0; i < totalSegments; i++) {
        const chunkDuration = (i === totalSegments - 1 && video.duration % SEGMENT_TIME !== 0)
            ? video.duration % SEGMENT_TIME : SEGMENT_TIME;
        m3u8 += `#EXTINF:${chunkDuration.toFixed(6)},\nstream${i}.ts\n`;
    }
    m3u8 += "#EXT-X-ENDLIST\n";

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(m3u8);
});

// TS 조각 파일 생성 라우터
router.get('/hls/:id/:quality/:file', (req, res) => {
    const { id, quality, file } = req.params;
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as VideoRecord | undefined;
    if (!video) return res.status(404).send('비디오를 찾을 수 없습니다.');

    const seqMatch = file.match(/stream(\d+)\.ts/);
    if (!seqMatch) return res.status(400).send('잘못된 요청입니다.');
    const seq = parseInt(seqMatch[1], 10);

    const outDir = path.join(HLS_TEMP_DIR, id.toString(), quality);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const filePath = path.join(outDir, file);

    const streamKey = getStreamKey(id, quality);

    // 타임아웃 갱신
    if (activeStreams[streamKey]?.timeout) {
        clearTimeout(activeStreams[streamKey].timeout);
        activeStreams[streamKey].timeout = setTimeout(() => cleanupStream(id, quality), SESSION_TIMEOUT_MS);
    }

    // 탐색(스킵) 감지 및 레이스 컨디션 방지
    let isSequential = true;
    if (activeStreams[streamKey]?.command && activeStreams[streamKey].currentSeq !== undefined) {
        const currentSeq = activeStreams[streamKey].currentSeq;
        
        // FFmpeg가 방금(3초 이내) 시작되었다면, 동시에 들어온 Safari의 다중 요청일 가능성이 높으므로 킬하지 않음
        const timeSinceStart = Date.now() - (activeStreams[streamKey].startTime || 0);
        if (timeSinceStart < 3000 && seq >= currentSeq && seq <= currentSeq + 5) {
            isSequential = true;
        } else if (seq < currentSeq) {
            // 현재 실행 중인 FFmpeg 시작점보다 과거 조각을 요청 (뒤로 탐색)
            isSequential = false;
        } else {
            // 현재 FFmpeg가 어디까지 생성했는지 확인
            let latestSeq = currentSeq;
            const dummyM3u8Path = path.join(outDir, 'dummy.m3u8');
            if (fs.existsSync(dummyM3u8Path)) {
                try {
                    const content = fs.readFileSync(dummyM3u8Path, 'utf8');
                    const matches = [...content.matchAll(/stream(\d+)\.ts/g)];
                    if (matches.length > 0) {
                        latestSeq = parseInt(matches[matches.length - 1][1], 10);
                    }
                } catch(e) {}
            }
            
            // HLS.js나 Safari가 미리 버퍼링하는 양은 보통 1~3개
            if (seq > latestSeq + 3) {
                isSequential = false; // 앞으로 탐색
            }
        }
    }

    if (!fs.existsSync(filePath)) {
        // 순차적이지 않으면 (즉 스킵/탐색의 경우) 기존 인코더 종료
        if (!isSequential && activeStreams[streamKey]?.command) {
            console.log(`🚀 탐색 감지됨: 기존 인코더 종료 및 seq=${seq} 부터 재시작`);
            activeStreams[streamKey].command.kill('SIGKILL');
            delete activeStreams[streamKey].command;
            
            // 이전 상태가 담긴 dummy.m3u8 삭제 (동시 요청 레이스 컨디션 방지)
            const dummyM3u8Path = path.join(outDir, 'dummy.m3u8');
            if (fs.existsSync(dummyM3u8Path)) {
                try { fs.unlinkSync(dummyM3u8Path); } catch(e) {}
            }
        }

        // 인코딩 시작
        if (!activeStreams[streamKey]?.command) {
            if (!activeStreams[streamKey]) activeStreams[streamKey] = {};

            const startTime = seq * SEGMENT_TIME;
            console.log(`🎬 [ID: ${id}] ${quality} 화질 인코딩 시작 (seq=${seq}, time=${startTime}s)`);

            const needsScale = quality !== 'original';

            // A/V 싱크를 위해 둘 다 copy 하거나 둘 다 인코딩
            let vCodec = 'libx264';
            let aCodec = 'aac';
            if (!needsScale && video.video_codec === 'h264' && video.audio_codec === 'aac') {
                vCodec = 'copy';
                aCodec = 'copy';
            }
            
            // 입력 옵션: 고속 탐색 (Input Seek) 및 멀티코어 디코딩 활성화
            const inputOptions = ['-threads', '0'];
            
            // AV1 비디오인 경우 libdav1d 디코더 강제 사용 (손상된 헤더 무시 및 호환성 확보)
            if (video.video_codec === 'av1' || video.video_codec === 'av01') {
                inputOptions.push('-c:v', 'libdav1d');
            }
            
            if (startTime > 0) {
                inputOptions.push('-ss', String(startTime));
            }

            const outputOptions = [
                '-threads', '0', // 멀티코어 인코딩 명시적 활성화
                '-c:v', vCodec,
                '-c:a', aCodec,
                '-start_number', String(seq),
                '-hls_time', String(SEGMENT_TIME),
                '-hls_list_size', '0',
                '-hls_flags', 'independent_segments+temp_file',
                '-hls_segment_filename', path.join(outDir, 'stream%d.ts'),
                '-f', 'hls'
            ];

            // PTS 시간 동기화 (재생 시간이 리셋되지 않고 startTime부터 시작되도록 강제)
            if (startTime > 0) {
                outputOptions.push('-output_ts_offset', String(startTime));
            }

            if (needsScale) {
                outputOptions.push('-vf', `scale=-2:${quality.replace('p', '')}`);
            }

            if (vCodec === 'libx264') {
                outputOptions.push('-preset', 'ultrafast');
                outputOptions.push('-g', '60');
                outputOptions.push('-sc_threshold', '0');
                // HLS 탐색 시 깨짐 방지를 위해 반드시 Closed GOP 사용
                outputOptions.push('-flags', '+cgop');
            }

            const command = ffmpeg(video.file_path)
                .inputOptions(inputOptions)
                .outputOptions(outputOptions)
                .output(path.join(outDir, 'dummy.m3u8'))
                .on('start', (cmd) => console.log(`✅ [${quality}] 실행 명령어:`, cmd))
                .on('stderr', (stderr) => {
                    if (stderr.toLowerCase().includes('error')) {
                        console.error(`❌ [${quality}] FFmpeg 에러:`, stderr);
                    }
                })
                .on('error', (err) => {
                    if (!err.message.includes('SIGKILL')) {
                        console.error(`❌ [${quality}] 인코딩 실패:`, err.message);
                    }
                    if (activeStreams[streamKey]) {
                        delete activeStreams[streamKey].command;
                    }
                })
                .on('end', () => {
                    console.log(`✅ [ID: ${id}] ${quality} 전체 인코딩 완료`);
                });

            activeStreams[streamKey].command = command;
            activeStreams[streamKey].currentSeq = seq;
            activeStreams[streamKey].startTime = Date.now();
            command.run();
        }
    }

    // TS 조각이 완전히 생성되었는지 확인하는 함수
    const isSegmentReady = () => {
        // 인코딩 명령어가 없으면 캐시된 파일이므로 존재하기만 하면 완료된 것으로 간주
        if (!activeStreams[streamKey]?.command) return fs.existsSync(filePath);

        // 만약 요청한 조각이 현재 실행 중인 FFmpeg의 시작 번호보다 이전 것이라면, 
        // 이는 과거의 인코딩으로 이미 100% 완료된 파일이므로 dummy.m3u8을 확인할 필요 없이 바로 반환
        if (activeStreams[streamKey].currentSeq !== undefined && seq < activeStreams[streamKey].currentSeq) {
            return fs.existsSync(filePath);
        }

        // FFmpeg가 아직 인코딩 중이라면 dummy.m3u8에 파일 이름이 쓰여졌는지 확인 (쓰여졌다면 해당 조각은 100% 완료된 것)
        const dummyM3u8Path = path.join(outDir, 'dummy.m3u8');
        if (fs.existsSync(dummyM3u8Path)) {
            try {
                return fs.readFileSync(dummyM3u8Path, 'utf8').includes(file);
            } catch (e) {
                return false;
            }
        }
        return false;
    };

    // 파일 생성 대기 (폴링)
    const serveFile = () => {
        if (isSegmentReady()) return res.sendFile(filePath);
        
        let attempts = 0;
        const maxAttempts = 100; // 100 * 300ms = 30초 대기
        
        const checkFileExists = setInterval(() => {
            if (isSegmentReady()) {
                clearInterval(checkFileExists);
                res.sendFile(filePath);
            } else {
                attempts++;
                if (attempts >= maxAttempts) {
                    clearInterval(checkFileExists);
                    if (!res.headersSent) res.status(500).send('스트리밍 준비 시간 초과');
                }
            }
        }, 300);
    };

    serveFile();
});

export default router;
