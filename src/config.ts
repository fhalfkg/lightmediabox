import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');

export interface AppConfig {
    mediaDir: string;
}

// 기본 설정
const DEFAULT_CONFIG: AppConfig = {
    mediaDir: path.resolve(process.cwd(), 'media')
};

export const getConfig = (): AppConfig => {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            // saveConfig를 직접 호출하지 않고 바로 쓰기하여 무한 재귀 방지
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
            return DEFAULT_CONFIG;
        }
        const data = fs.readFileSync(CONFIG_PATH, 'utf8');
        return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
    } catch (err) {
        console.error('설정 파일을 읽는 중 오류 발생:', err);
        return DEFAULT_CONFIG;
    }
};

export const saveConfig = (config: Partial<AppConfig>) => {
    try {
        let currentConfig = DEFAULT_CONFIG;
        if (fs.existsSync(CONFIG_PATH)) {
            const data = fs.readFileSync(CONFIG_PATH, 'utf8');
            currentConfig = { ...DEFAULT_CONFIG, ...JSON.parse(data) };
        }
        const newConfig = { ...currentConfig, ...config };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf8');
    } catch (err) {
        console.error('설정 파일을 저장하는 중 오류 발생:', err);
    }
};
