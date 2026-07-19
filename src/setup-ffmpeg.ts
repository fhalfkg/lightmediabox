import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import https from 'https';

const FFMPEG_DIR = path.resolve(process.cwd(), 'ffmpeg');

export const getFfmpegPath = () => {
    const ext = os.platform() === 'win32' ? '.exe' : '';
    const localPath = path.join(FFMPEG_DIR, `ffmpeg${ext}`);
    if (fs.existsSync(localPath)) return localPath;
    
    if (os.platform() !== 'win32') return 'ffmpeg';
    return localPath;
};

export const getFfprobePath = () => {
    const ext = os.platform() === 'win32' ? '.exe' : '';
    const localPath = path.join(FFMPEG_DIR, `ffprobe${ext}`);
    if (fs.existsSync(localPath)) return localPath;
    
    if (os.platform() !== 'win32') return 'ffprobe';
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
                fs.unlinkSync(dest);
                reject(err);
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
};

export const setupFfmpeg = async () => {
    const platform = os.platform();

    if (platform === 'win32') {
        const ffmpegExe = path.join(FFMPEG_DIR, 'ffmpeg.exe');
        const ffprobeExe = path.join(FFMPEG_DIR, 'ffprobe.exe');
        if (fs.existsSync(ffmpegExe) && fs.existsSync(ffprobeExe)) {
            console.log('✅ 로컬 ffmpeg 및 ffprobe를 사용합니다.');
            return;
        }

        console.log('⬇️ Windows용 ffmpeg를 다운로드 중입니다... (BtbN / full version with libdav1d)');
        const zipUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
        const zipPath = path.join(process.cwd(), 'ffmpeg-release.zip');
        
        await downloadFile(zipUrl, zipPath);
        
        console.log('📦 ffmpeg 압축을 해제하고 있습니다... (이 작업은 다소 시간이 소요될 수 있습니다)');
        const extractPath = path.join(process.cwd(), 'ffmpeg-temp');
        if (!fs.existsSync(extractPath)) fs.mkdirSync(extractPath);
        
        execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractPath}' -Force"`, { stdio: 'inherit' });
        
        const folders = fs.readdirSync(extractPath);
        const ffmpegFolder = folders.find(f => f.startsWith('ffmpeg-'));
        if (!ffmpegFolder) throw new Error('Cannot find extracted ffmpeg folder');
        
        const extractedBin = path.join(extractPath, ffmpegFolder, 'bin');
        if (!fs.existsSync(FFMPEG_DIR)) fs.mkdirSync(FFMPEG_DIR, { recursive: true });
        
        // bin 폴더 안의 파일들을 FFMPEG_DIR로 바로 복사
        fs.cpSync(extractedBin, FFMPEG_DIR, { recursive: true });
        
        // Cleanup
        fs.rmSync(extractPath, { recursive: true, force: true });
        fs.unlinkSync(zipPath);
        
        console.log('✅ ffmpeg 설치가 완료되었습니다.');
    } else {
        // Linux or other
        const localFfmpeg = path.join(FFMPEG_DIR, 'ffmpeg');
        const localFfprobe = path.join(FFMPEG_DIR, 'ffprobe');
        if (fs.existsSync(localFfmpeg) && fs.existsSync(localFfprobe)) {
            console.log('✅ 로컬 ffmpeg 및 ffprobe를 사용합니다.');
            return;
        }

        try {
            execSync('ffmpeg -version', { stdio: 'ignore' });
            execSync('ffprobe -version', { stdio: 'ignore' });
            console.log('✅ 시스템 ffmpeg 및 ffprobe를 사용합니다.');
        } catch (e) {
            console.error('❌ 시스템에 ffmpeg 또는 ffprobe가 설치되어 있지 않습니다.');
            console.error('👉 패키지 관리자를 사용해 ffmpeg를 설치해주세요. (예: sudo apt install ffmpeg)');
            process.exit(1);
        }
    }
};
