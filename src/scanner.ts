import { watch, FSWatcher } from 'chokidar';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import db from './db';
import crypto from 'crypto';
import { getConfig } from './config';

// ffmpeg & ffprobe 경로 설정
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

const THUMBNAIL_DIR = path.resolve(process.cwd(), 'public/thumbnails');

// 폴더가 없으면 생성
if (!fs.existsSync(THUMBNAIL_DIR)) fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });

let watcher: FSWatcher | null = null;

// 비디오 파일 확장자 필터
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.webm'];

class TaskQueue {
    private queue: (() => Promise<void>)[] = [];
    private running = 0;
    private concurrency: number;

    constructor(concurrency: number) {
        this.concurrency = concurrency;
    }

    add(task: () => Promise<void>) {
        this.queue.push(task);
        this.next();
    }

    private next() {
        if (this.running >= this.concurrency || this.queue.length === 0) {
            return;
        }
        const task = this.queue.shift();
        if (task) {
            this.running++;
            task().finally(() => {
                this.running--;
                this.next();
            });
        }
    }
}

const scannerQueue = new TaskQueue(4);

/**
 * ID 기반 썸네일 해시 경로 생성기
 */
export const getThumbnailPath = (id: number | string) => {
    const hash = crypto.createHash('md5').update(id.toString()).digest('hex');
    const folderName = hash.substring(0, 2);
    const fileName = `${hash}.jpg`;

    return {
        url: `/thumbnails/${folderName}/${fileName}`,
        folderPath: path.join(THUMBNAIL_DIR, folderName),
        absolutePath: path.join(THUMBNAIL_DIR, folderName, fileName),
    };
};

/**
 * FFprobe를 사용하여 메타데이터 추출 (Duration 등)
 */
const extractMetadata = (filePath: string): Promise<any> => {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                console.warn(`⚠️ 메타데이터 추출 실패 (강제 등록됨): ${path.basename(filePath)} - ${err.message.split('\n')[0]}`);
                let size = 0;
                try { size = fs.statSync(filePath).size; } catch (e) { }
                return resolve({
                    duration: 0,
                    size: size,
                    container: path.extname(filePath).replace('.', ''),
                    videoCodec: 'unknown',
                    audioCodec: 'unknown',
                    resolution: 'unknown',
                });
            }

            const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
            const audioStream = metadata.streams.find((s) => s.codec_type === 'audio');
            const format = metadata.format;

            if (!videoStream) {
                return resolve({
                    duration: format.duration || 0,
                    size: format.size || 0,
                    container: format.format_name || path.extname(filePath).replace('.', ''),
                    videoCodec: 'unknown',
                    audioCodec: audioStream?.codec_name || 'none',
                    resolution: 'unknown',
                });
            }

            resolve({
                duration: format.duration,
                size: format.size,
                container: format.format_name,
                videoCodec: videoStream.codec_name,
                audioCodec: audioStream?.codec_name || 'none',
                resolution: `${videoStream.width}x${videoStream.height}`,
            });
        });
    });
};

/**
 * FFmpeg를 사용하여 영상의 10% 지점에서 썸네일 생성
 */
const generateThumbnail = (filePath: string, id: number | bigint): Promise<void> => {
    return new Promise((resolve, reject) => {
        const thumbInfo = getThumbnailPath(id.toString());

        // 해싱된 폴더(예: public/thumbnails/c4)가 없으면 생성
        if (!fs.existsSync(thumbInfo.folderPath)) {
            fs.mkdirSync(thumbInfo.folderPath, { recursive: true });
        }

        if (fs.existsSync(thumbInfo.absolutePath)) return resolve();

        ffmpeg(filePath)
            .outputOptions(['-pix_fmt yuvj420p'])
            .screenshots({
                timestamps: ['10%'],
                filename: path.basename(thumbInfo.absolutePath),
                folder: thumbInfo.folderPath,
                size: '480x?'
            })
            .on('end', () => {
                console.log(`🖼️ 썸네일 생성 완료: ${thumbInfo.url}`);
                resolve();
            })
            .on('error', (err) => {
                console.error(`❌ 썸네일 생성 실패 (${id}):`, err.message);
                reject(err);
            });
    });
};

/**
 * 기존 비디오 썸네일 일괄 생성 및 마이그레이션
 */
const generateMissingThumbnails = async () => {
    try {
        const videos = db.prepare('SELECT id, file_path FROM videos').all() as any[];
        for (const video of videos) {
            const thumbInfo = getThumbnailPath(video.id);

            // 기존 1.jpg 형태의 구 버전 파일이 있는지 확인 후 마이그레이션
            const legacyPath = path.join(THUMBNAIL_DIR, `${video.id}.jpg`);
            if (fs.existsSync(legacyPath)) {
                if (!fs.existsSync(thumbInfo.folderPath)) {
                    fs.mkdirSync(thumbInfo.folderPath, { recursive: true });
                }
                fs.renameSync(legacyPath, thumbInfo.absolutePath);
                console.log(`🔄 썸네일 마이그레이션 완료: ${video.id}.jpg -> ${thumbInfo.url}`);
            }

            if (!fs.existsSync(thumbInfo.absolutePath) && fs.existsSync(video.file_path)) {
                scannerQueue.add(() => generateThumbnail(video.file_path, video.id).catch(() => { }));
            }
        }
    } catch (err) {
        console.error('기존 썸네일 일괄 생성 오류:', err);
    }
};

/**
 * DB에 메타데이터 삽입
 */
const insertVideoStmt = db.prepare(`
  INSERT INTO videos (
    file_name, file_path, file_size, duration, 
    resolution, video_codec, audio_codec, container_format
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

export const startScanner = () => {
    const { mediaDir } = getConfig();
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

    // 서버 재시작 시 DB와 실제 파일 시스템 동기화 (Ghost 엔트리 제거)
    const allVideos = db.prepare('SELECT id, file_path FROM videos').all() as any[];
    for (const v of allVideos) {
        if (!fs.existsSync(v.file_path)) {
            console.log(`🗑️ 사라진 비디오 정리됨: ${path.basename(v.file_path)}`);
            db.prepare('DELETE FROM videos WHERE id = ?').run(v.id);
            const thumbInfo = getThumbnailPath(v.id);
            if (fs.existsSync(thumbInfo.absolutePath)) fs.unlinkSync(thumbInfo.absolutePath);
            const legacyPath = path.join(process.cwd(), 'public', 'thumbnails', `${v.id}.jpg`);
            if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
        }
    }

    console.log(`🔍 스캐너 시작: ${mediaDir} 폴더 감시 중...`);

    // 시작 시 기존 썸네일 검사(마이그레이션 포함)
    generateMissingThumbnails();

    // chokidar 옵션 설정
    watcher = watch(mediaDir, {
        ignored: /(^|[\/\\])\../, // 숨김 파일 무시
        persistent: true,
        awaitWriteFinish: { // 파일 복사가 완전히 끝난 후 이벤트 발생
            stabilityThreshold: 2000,
            pollInterval: 100,
        },
    });

    const processingFiles = new Set<string>();

    watcher.on('add', async (filePath) => {
        const ext = path.extname(filePath).toLowerCase();

        if (VIDEO_EXTENSIONS.includes(ext)) {
            if (processingFiles.has(filePath)) return;
            processingFiles.add(filePath);

            scannerQueue.add(async () => {
                try {
                    // 이미 DB에 존재하는 파일인지 확인 (경로 기준)
                    const existing: any = db.prepare('SELECT id FROM videos WHERE file_path = ?').get(filePath);
                    if (existing) {
                        console.log(`➡️ 기존에 존재하는 비디오: ${path.basename(filePath)}`);
                        // 파일은 있는데 썸네일이 없을 수 있으므로 큐에 생성 작업 추가
                        scannerQueue.add(() => generateThumbnail(filePath, existing.id).catch(() => { }));
                        return;
                    }

                    console.log(`🎬 새 비디오 감지됨: ${path.basename(filePath)}`);
                    const fileName = path.basename(filePath);
                    const metadata = await extractMetadata(filePath);
                    console.log(`✅ 메타데이터 추출 완료: ${fileName}`);

                    // 트랜잭션으로 DB 삽입
                    const insert = db.transaction(() => {
                        return insertVideoStmt.run(
                            fileName,
                            filePath,
                            metadata.size || 0,
                            metadata.duration || 0,
                            metadata.resolution,
                            metadata.videoCodec,
                            metadata.audioCodec,
                            metadata.container
                        );
                    });

                    try {
                        const result = insert();
                        // 썸네일 생성 작업 큐에 추가
                        scannerQueue.add(() => generateThumbnail(filePath, result.lastInsertRowid).catch(() => { }));
                    } catch (insertError: any) {
                        if (insertError.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                            console.log(`➡️ 이미 등록된 비디오 (중복 무시됨): ${fileName}`);
                        } else {
                            throw insertError;
                        }
                    }
                } catch (error) {
                    console.error(`❌ 메타데이터 추출/저장 실패 (${filePath}):`, error);
                } finally {
                    processingFiles.delete(filePath);
                }
            });
        }
    });

    watcher.on('unlink', (filePath) => {
        const ext = path.extname(filePath).toLowerCase();

        if (VIDEO_EXTENSIONS.includes(ext)) {
            console.log(`🗑️ 비디오 삭제 감지됨: ${path.basename(filePath)}`);

            // DB에서 해당 파일 레코드 찾기
            const existing: any = db.prepare('SELECT id FROM videos WHERE file_path = ?').get(filePath);

            if (existing) {
                // DB에서 레코드 삭제
                db.prepare('DELETE FROM videos WHERE id = ?').run(existing.id);
                console.log(`✅ DB에서 삭제 완료: ${path.basename(filePath)}`);

                // 썸네일 새 로직 변경(해싱 경로 지정)
                const thumbInfo = getThumbnailPath(existing.id);
                if (fs.existsSync(thumbInfo.absolutePath)) {
                    fs.unlinkSync(thumbInfo.absolutePath);
                }

                // 기존 레거시 파일 혹시 남아있으면 삭제
                const legacyPath = path.join(THUMBNAIL_DIR, `${existing.id}.jpg`);
                if (fs.existsSync(legacyPath)) {
                    fs.unlinkSync(legacyPath);
                }
            }
        }
    });
};

export const stopScanner = async () => {
    if (watcher) {
        await watcher.close();
        watcher = null;
        console.log('?? ��ĳ�� ���ð� �����Ǿ����ϴ�.');
    }
};
