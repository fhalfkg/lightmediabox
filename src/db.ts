import Database from 'better-sqlite3';
import path from 'path';

// 프로젝트 루트에 media.db 파일 생성
const dbPath = path.resolve(process.cwd(), 'media.db');
const db = new Database(dbPath);

// 모듈이 임포트되는 즉시 테이블 및 인덱스 생성 (순서 문제 해결)
db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT,
    file_path TEXT UNIQUE, 
    file_size INTEGER,
    duration REAL,
    resolution TEXT,
    video_codec TEXT,
    audio_codec TEXT,
    container_format TEXT,
    type TEXT DEFAULT 'video',
    scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP  
  );

  -- ⚡ 인덱싱 추가 (조회 및 검색 성능 최적화)
  -- file_path는 스캐너가 중복 검사를 할 때 매우 자주 조회됩니다.
  CREATE INDEX IF NOT EXISTS idx_videos_file_path ON videos(file_path);
  
  -- 최근 추가된 영상부터 정렬할 때 속도를 높이기 위한 인덱스입니다.
  CREATE INDEX IF NOT EXISTS idx_videos_scanned_at ON videos(scanned_at);

  -- 나중에 파일명으로 검색하는 기능을 위해 추가해 둡니다.
  CREATE INDEX IF NOT EXISTS idx_videos_file_name ON videos(file_name);

  -- ⚡ 사용자 테이블 (아이디/비밀번호 기반 로그인 용)
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- ⚡ 패스키 테이블 (WebAuthn 2FA 용)
  CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    credential_id TEXT UNIQUE NOT NULL,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL,
    transports TEXT,
    name TEXT,
    device_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// 기존 데이터베이스를 위한 마이그레이션 로직 (패스키 이름 기능 추가)
try {
  db.exec('ALTER TABLE passkeys ADD COLUMN name TEXT;');
} catch (err) { /* 이미 존재하는 경우 무시 */ }

try {
  db.exec('ALTER TABLE passkeys ADD COLUMN device_name TEXT;');
} catch (err) { /* 이미 존재하는 경우 무시 */ }

try {
  db.exec('ALTER TABLE videos ADD COLUMN type TEXT DEFAULT \'video\';');
} catch (err) { /* 이미 존재하는 경우 무시 */ }

console.log('✅ 데이터베이스 테이블 및 인덱스 초기화 완료');

export default db;
