import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import https from 'https';

const FFMPEG_DIR = path.resolve(process.cwd(), 'ffmpeg');

let resolvedFfmpegPath: string | null = null;
let resolvedFfprobePath: string | null = null;

export const getFfmpegPath = () => {
    if (resolvedFfmpegPath) return resolvedFfmpegPath;

    const ext = os.platform() === 'win32' ? '.exe' : '';
    const localPath = path.join(FFMPEG_DIR, `ffmpeg${ext}`);
    if (fs.existsSync(localPath)) return localPath;

    if (os.platform() !== 'win32') {
        const systemJellyfin = ['/usr/lib/jellyfin-ffmpeg/ffmpeg', '/usr/bin/jellyfin-ffmpeg'];
        for (const p of systemJellyfin) {
            if (fs.existsSync(p)) return p;
        }
    }
    return localPath;
};

export const getFfprobePath = () => {
    if (resolvedFfprobePath) return resolvedFfprobePath;

    const ext = os.platform() === 'win32' ? '.exe' : '';
    const localPath = path.join(FFMPEG_DIR, `ffprobe${ext}`);
    if (fs.existsSync(localPath)) return localPath;

    if (os.platform() !== 'win32') {
        const systemJellyfin = ['/usr/lib/jellyfin-ffmpeg/ffprobe', '/usr/bin/jellyfin-ffprobe'];
        for (const p of systemJellyfin) {
            if (fs.existsSync(p)) return p;
        }
    }
    return localPath;
};

const downloadFile = (url: string, dest: string): Promise<void> => {
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                let redirectUrl = response.headers.location;
                if (!redirectUrl.startsWith('http')) {
                    const parsedUrl = new URL(url);
                    redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
                }
                return downloadFile(redirectUrl, dest).then(resolve).catch(reject);
            }
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }

            const file = fs.createWriteStream(dest);
            response.pipe(file);
            file.on('finish', () => {
                file.close((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            file.on('error', (err) => {
                file.close();
                if (fs.existsSync(dest)) fs.unlinkSync(dest);
                reject(err);
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
};

// 재귀적 파일 검색 헬퍼
const findFileRecursive = (dir: string, fileName: string): string | null => {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFileRecursive(fullPath, fileName);
            if (found) return found;
        } else if (entry.name === fileName) {
            return fullPath;
        }
    }
    return null;
};

export const setupFfmpeg = async () => {
    const platform = os.platform();
    const ext = platform === 'win32' ? '.exe' : '';
    const ffmpegBinName = `ffmpeg${ext}`;
    const ffprobeBinName = `ffprobe${ext}`;

    const localFfmpeg = path.join(FFMPEG_DIR, ffmpegBinName);
    const localFfprobe = path.join(FFMPEG_DIR, ffprobeBinName);

    // 1. 이미 다운로드된 로컬 jellyfin-ffmpeg 확인
    if (fs.existsSync(localFfmpeg) && fs.existsSync(localFfprobe)) {
        console.log('✅ 로컬 jellyfin-ffmpeg 및 ffprobe를 사용합니다.');
        resolvedFfmpegPath = localFfmpeg;
        resolvedFfprobePath = localFfprobe;
        return;
    }

    // 2. Linux 시스템 패키지로 설치된 jellyfin-ffmpeg 확인 (/usr/lib/jellyfin-ffmpeg/ 또는 /usr/bin/jellyfin-ffmpeg)
    if (platform !== 'win32') {
        const systemJellyfinFfmpegPaths = ['/usr/lib/jellyfin-ffmpeg/ffmpeg', '/usr/bin/jellyfin-ffmpeg'];
        const systemJellyfinFfprobePaths = ['/usr/lib/jellyfin-ffmpeg/ffprobe', '/usr/bin/jellyfin-ffprobe'];

        for (let i = 0; i < systemJellyfinFfmpegPaths.length; i++) {
            const ffmpegP = systemJellyfinFfmpegPaths[i];
            const ffprobeP = systemJellyfinFfprobePaths[i];
            if (fs.existsSync(ffmpegP) && fs.existsSync(ffprobeP)) {
                console.log(`🚀 시스템 최적화 jellyfin-ffmpeg 인코더를 사용합니다. (${ffmpegP})`);
                resolvedFfmpegPath = ffmpegP;
                resolvedFfprobePath = ffprobeP;
                return;
            }
        }
    }

    // 3. 로컬/시스템에 jellyfin-ffmpeg가 없으면 100% jellyfin-ffmpeg 8.x 포터블 바이너리를 다운로드
    console.log(`⬇️ jellyfin-ffmpeg 8.x 최적화 포터블 인코더를 다운로드 중입니다... (${platform})`);
    
    if (!fs.existsSync(FFMPEG_DIR)) fs.mkdirSync(FFMPEG_DIR, { recursive: true });
    const extractTempPath = path.join(process.cwd(), 'ffmpeg-temp');
    if (!fs.existsSync(extractTempPath)) fs.mkdirSync(extractTempPath, { recursive: true });

    if (platform === 'win32') {
        const zipUrl = 'https://repo.jellyfin.org/files/ffmpeg/windows/latest-8.x/win64/jellyfin-ffmpeg_8.1.2-2_portable_win64-clang-gpl.zip';
        const zipPath = path.join(process.cwd(), 'jellyfin-ffmpeg-release.zip');
        
        await downloadFile(zipUrl, zipPath);
        
        console.log('📦 jellyfin-ffmpeg 압축을 해제하는 중입니다...');
        execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractTempPath}' -Force"`, { stdio: 'inherit' });
        
        const foundFfmpeg = findFileRecursive(extractTempPath, 'ffmpeg.exe');
        const foundFfprobe = findFileRecursive(extractTempPath, 'ffprobe.exe');
        
        if (foundFfmpeg && foundFfprobe) {
            fs.copyFileSync(foundFfmpeg, localFfmpeg);
            fs.copyFileSync(foundFfprobe, localFfprobe);
        } else {
            throw new Error('jellyfin-ffmpeg 바이너리를 추출하지 못했습니다.');
        }

        // Cleanup
        fs.rmSync(extractTempPath, { recursive: true, force: true });
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    } else {
        // Linux (amd64)
        const tarUrl = 'https://repo.jellyfin.org/files/ffmpeg/linux/latest-8.x/amd64/jellyfin-ffmpeg_8.1.2-2_portable_linux64-gpl.tar.xz';
        const tarPath = path.join(process.cwd(), 'jellyfin-ffmpeg-release.tar.xz');

        await downloadFile(tarUrl, tarPath);

        console.log('📦 jellyfin-ffmpeg (Linux x64) 압축을 해제하는 중입니다...');
        execSync(`tar -xf "${tarPath}" -C "${extractTempPath}"`, { stdio: 'inherit' });

        const foundFfmpeg = findFileRecursive(extractTempPath, 'ffmpeg');
        const foundFfprobe = findFileRecursive(extractTempPath, 'ffprobe');

        if (foundFfmpeg && foundFfprobe) {
            fs.copyFileSync(foundFfmpeg, localFfmpeg);
            fs.copyFileSync(foundFfprobe, localFfprobe);
            fs.chmodSync(localFfmpeg, 0o755);
            fs.chmodSync(localFfprobe, 0o755);
        } else {
            throw new Error('jellyfin-ffmpeg 바이너리를 추출하지 못했습니다.');
        }

        // Cleanup
        fs.rmSync(extractTempPath, { recursive: true, force: true });
        if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
    }

    resolvedFfmpegPath = localFfmpeg;
    resolvedFfprobePath = localFfprobe;
    console.log('🚀 jellyfin-ffmpeg 8.x 최적화 인코더 설치가 완료되었습니다.');
};
