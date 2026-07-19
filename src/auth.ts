import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import db from './db';
import {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const router = express.Router();

const rpName = 'LightMediaBox';

// User-Agent를 기반으로 기기명(OS) 추출
function getDeviceName(userAgent?: string): string {
    if (!userAgent) return '알 수 없는 기기';
    if (/iPhone/i.test(userAgent)) return 'iPhone';
    if (/iPad/i.test(userAgent)) return 'iPad';
    if (/Mac OS X/i.test(userAgent)) return 'Mac';
    if (/Android/i.test(userAgent)) return 'Android';
    if (/Windows/i.test(userAgent)) return 'Windows';
    if (/Linux/i.test(userAgent)) return 'Linux';
    return '알 수 없는 기기';
}
// rpID는 요청 호스트(req.hostname)를 동적으로 사용합니다.

// 세션 타입 확장을 위해 declare global 사용
declare module 'express-session' {
    interface SessionData {
        userId?: string;
        username?: string;
        pendingUserId?: string; // 1차 로그인(비밀번호) 성공 후 2FA 대기 중인 유저
        currentChallenge?: string;
    }
}

// ─── API: 현재 세션 상태 확인 ───
router.get('/session', (req, res) => {
    if (process.env.NODE_ENV === 'development') {
        return res.json({ loggedIn: true, username: 'DevUser' });
    }
    if (req.session.userId) {
        return res.json({ loggedIn: true, username: req.session.username });
    }
    res.json({ loggedIn: false });
});

// ─── API: 초기 설정 상태 확인 (온보딩 용) ───
router.get('/setup-status', (req, res) => {
    try {
        const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
        res.json({ isSetup: row.count > 0 });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'DB Error' });
    }
});

// ─── API: 로그아웃 ───
router.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

// ─── API: 회원가입 (최초 1명만 허용) ───
router.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });

    try {
        // 이미 가입된 유저가 있는지 확인 (1명만 가입 허용)
        const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
        if (userCount.count > 0) {
            return res.status(403).json({ error: '이미 관리자 계정이 존재합니다. 가입이 불가능합니다.' });
        }

        const id = crypto.randomUUID();
        const hash = await bcrypt.hash(password, 10);
        
        db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(id, username, hash);
        
        res.json({ success: true, message: '회원가입이 완료되었습니다.' });
    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: '회원가입 중 오류가 발생했습니다.' });
    }
});

// ─── API: 미디어 스트리밍용 임시 토큰 발급 (Chromecast, AirPlay 용) ───
router.get('/stream-token', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: '인증이 필요합니다.' });

    try {
        const secret = process.env.SESSION_SECRET || 'default_secret_key';
        const token = jwt.sign({ userId: req.session.userId }, secret, { expiresIn: '12h' });
        res.json({ token });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: '스트리밍 토큰 발급 중 오류가 발생했습니다.' });
    }
});

// 로그인 시도 제한 (Brute-force 방어)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15분
    max: 5, // 15분당 최대 5번 요청 허용
    message: { error: '로그인 시도 횟수를 초과했습니다. 15분 후에 다시 시도해주세요.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// ─── API: 1단계 로그인 (비밀번호 검증) ───
router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });

    try {
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
        if (!user) return res.status(401).json({ error: '아이디 또는 비밀번호가 잘못되었습니다.' });

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: '아이디 또는 비밀번호가 잘못되었습니다.' });

        // 비밀번호 맞음. 2FA 대기 상태로 세션 변경
        req.session.pendingUserId = user.id;

        // 패스키 등록 여부 확인
        const passkeys = db.prepare('SELECT * FROM passkeys WHERE user_id = ?').all(user.id);
        const hasPasskey = passkeys.length > 0;

        res.json({ success: true, require2FA: true, hasPasskey });
    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: '로그인 중 오류가 발생했습니다.' });
    }
});

// ─── API: 비밀번호 변경 ───
router.post('/change-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const userId = req.session.userId;
    
    if (!userId) return res.status(401).json({ error: '로그인이 필요합니다.' });
    if (!currentPassword || !newPassword) return res.status(400).json({ error: '현재 비밀번호와 새 비밀번호를 모두 입력해주세요.' });

    try {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
        if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });

        const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
        if (!isMatch) return res.status(401).json({ error: '현재 비밀번호가 일치하지 않습니다.' });

        const newHash = await bcrypt.hash(newPassword, 10);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, userId);

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: '비밀번호 변경 중 오류가 발생했습니다.' });
    }
});

// ─── API: 패스키 등록 옵션 생성 ───
router.get('/passkey/register-options', async (req, res) => {
    const userId = req.session.pendingUserId || req.session.userId;
    if (!userId) return res.status(401).json({ error: '사용자 정보가 없습니다.' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });

    const passkeys = db.prepare('SELECT * FROM passkeys WHERE user_id = ?').all(userId) as any[];

    const options = await generateRegistrationOptions({
        rpName,
        rpID: req.hostname,
        userID: new Uint8Array(crypto.createHash('sha256').update(user.id).digest()),
        userName: user.username,
        attestationType: 'none',
        excludeCredentials: passkeys.map(pk => ({
            id: pk.credential_id,
            type: 'public-key',
        })),
        authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'preferred',
        },
    });

    req.session.currentChallenge = options.challenge;
    res.json(options);
});

// ─── API: 패스키 등록 검증 ───
router.post('/passkey/register-verify', async (req, res) => {
    const userId = req.session.pendingUserId || req.session.userId;
    const expectedChallenge = req.session.currentChallenge;

    if (!userId || !expectedChallenge) {
        return res.status(400).json({ error: '세션이 만료되었습니다. 처음부터 다시 시도해주세요.' });
    }

    const body = req.body;
    let verification;
    try {
        const origin = req.get('origin') || `http://${req.get('host')}`;
        verification = await verifyRegistrationResponse({
            response: body,
            expectedChallenge,
            expectedOrigin: origin,
            expectedRPID: req.hostname,
        });
    } catch (error: any) {
        console.error(error);
        return res.status(400).json({ error: error.message });
    }

    if (verification.verified && verification.registrationInfo) {
        const { credential } = verification.registrationInfo;

        const id = crypto.randomUUID();
        const credIdB64 = credential.id;

        const deviceName = getDeviceName(req.headers['user-agent'] as string);

        db.prepare(`
            INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, name, device_name) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, userId, credIdB64, Buffer.from(credential.publicKey), credential.counter, deviceName, deviceName);

        // 2FA 완료 -> 최종 로그인 처리
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
        req.session.userId = userId;
        req.session.username = user.username;
        delete req.session.pendingUserId;
        delete req.session.currentChallenge;

        res.json({ verified: true });
    } else {
        res.status(400).json({ error: '패스키 등록에 실패했습니다.' });
    }
});

// ─── API: 패스키 인증 옵션 생성 ───
router.get('/passkey/auth-options', async (req, res) => {
    const userId = req.session.pendingUserId;
    if (!userId) return res.status(401).json({ error: '1단계 로그인이 필요합니다.' });

    const passkeys = db.prepare('SELECT * FROM passkeys WHERE user_id = ?').all(userId) as any[];
    if (passkeys.length === 0) return res.status(400).json({ error: '등록된 패스키가 없습니다.' });

    const options = await generateAuthenticationOptions({
        rpID: req.hostname,
        allowCredentials: passkeys.map(pk => ({
            id: pk.credential_id,
            type: 'public-key',
        })),
        userVerification: 'preferred',
    });

    req.session.currentChallenge = options.challenge;
    res.json(options);
});

// ─── API: 패스키 인증 검증 ───
router.post('/passkey/auth-verify', async (req, res) => {
    const userId = req.session.pendingUserId;
    const expectedChallenge = req.session.currentChallenge;

    if (!userId || !expectedChallenge) {
        return res.status(400).json({ error: '세션이 만료되었습니다. 처음부터 다시 시도해주세요.' });
    }

    const body = req.body;
    const credIdStr = body.id;
    const passkey = db.prepare('SELECT * FROM passkeys WHERE user_id = ? AND credential_id = ?').get(userId, credIdStr) as any;

    if (!passkey) {
        return res.status(400).json({ error: '알 수 없는 패스키입니다.' });
    }

    let verification;
    try {
        const origin = req.get('origin') || `http://${req.get('host')}`;
        verification = await verifyAuthenticationResponse({
            response: body,
            expectedChallenge,
            expectedOrigin: origin,
            expectedRPID: req.hostname,
            credential: {
                id: passkey.credential_id,
                publicKey: new Uint8Array(passkey.public_key), // it's stored as BLOB
                counter: passkey.counter,
                transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
            },
        });
    } catch (error: any) {
        console.error(error);
        return res.status(400).json({ error: error.message });
    }

    if (verification.verified && verification.authenticationInfo) {
        // Update counter
        db.prepare('UPDATE passkeys SET counter = ? WHERE id = ?').run(
            verification.authenticationInfo.newCounter, 
            passkey.id
        );

        // 2FA 완료 -> 최종 로그인 처리
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
        req.session.userId = userId;
        req.session.username = user.username;
        delete req.session.pendingUserId;
        delete req.session.currentChallenge;

        res.json({ verified: true });
    } else {
        res.status(400).json({ error: '패스키 인증에 실패했습니다.' });
    }
});

// ─── API: 계정 정보 및 등록된 패스키 목록 조회 ───
router.get('/account-info', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: '인증이 필요합니다.' });

    try {
        const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.session.userId) as any;
        const passkeys = db.prepare('SELECT id, credential_id, created_at, name, device_name FROM passkeys WHERE user_id = ? ORDER BY created_at ASC').all(req.session.userId) as any[];
        
        res.json({
            username: user.username,
            passkeys: passkeys.map(pk => ({
                id: pk.id,
                credential_id: pk.credential_id, // Base64URL string
                created_at: pk.created_at,
                name: pk.name || pk.device_name || '알 수 없는 기기',
                device_name: pk.device_name || '알 수 없는 기기'
            }))
        });
    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: '계정 정보를 불러오는 중 오류가 발생했습니다.' });
    }
});

// ─── API: 패스키 이름 변경 ───
router.put('/passkeys/:id/name', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: '인증이 필요합니다.' });
    
    const newName = req.body.name;
    if (!newName || newName.trim() === '') {
        return res.status(400).json({ error: '이름을 입력해주세요.' });
    }

    try {
        const result = db.prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?').run(newName.trim(), req.params.id, req.session.userId);
        if (result.changes === 0) {
            return res.status(404).json({ error: '패스키를 찾을 수 없거나 권한이 없습니다.' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: '이름 변경 중 오류가 발생했습니다.' });
    }
});

// ─── API: 특정 패스키 삭제 ───
router.delete('/passkeys/:id', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: '인증이 필요합니다.' });

    try {
        const countRow = db.prepare('SELECT COUNT(*) as count FROM passkeys WHERE user_id = ?').get(req.session.userId) as { count: number };
        if (countRow.count <= 1) {
            return res.status(400).json({ error: '최소 1개의 패스키는 유지해야 합니다. (모든 패스키 삭제 불가)' });
        }

        const result = db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(req.params.id, req.session.userId);
        if (result.changes === 0) {
            return res.status(404).json({ error: '패스키를 찾을 수 없거나 삭제할 권한이 없습니다.' });
        }

        res.json({ success: true });
    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: '패스키 삭제 중 오류가 발생했습니다.' });
    }
});

// ─── API: 새로운 패스키 추가 (옵션 생성) ───
router.get('/passkey/add-options', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: '인증이 필요합니다.' });

    try {
        const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.session.userId) as any;
        const existingPasskeys = db.prepare('SELECT credential_id FROM passkeys WHERE user_id = ?').all(req.session.userId) as any[];

        const options = await generateRegistrationOptions({
            rpName,
            rpID: req.hostname,
            userID: new Uint8Array(crypto.createHash('sha256').update(req.session.userId).digest()),
            userName: user.username,
            attestationType: 'none',
            authenticatorSelection: {
                residentKey: 'required',
                userVerification: 'preferred',
            }
        });

        req.session.currentChallenge = options.challenge;
        res.json(options);
    } catch (error: any) {
        console.error(error);
        res.status(500).json({ error: '패스키 등록 옵션 생성 중 오류가 발생했습니다.' });
    }
});

// ─── API: 새로운 패스키 추가 (응답 검증) ───
router.post('/passkey/add-verify', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: '인증이 필요합니다.' });
    const expectedChallenge = req.session.currentChallenge;
    if (!expectedChallenge) {
        return res.status(400).json({ error: '진행 중인 패스키 등록 세션이 없습니다.' });
    }

    try {
        const origin = req.get('origin') || `http://${req.get('host')}`;
        const verification = await verifyRegistrationResponse({
            response: req.body,
            expectedChallenge,
            expectedOrigin: origin,
            expectedRPID: req.hostname,
        });

        if (verification.verified && verification.registrationInfo) {
            const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
            const deviceName = getDeviceName(req.headers['user-agent'] as string);
            
            db.prepare(`
                INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, name, device_name) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                crypto.randomUUID(),
                req.session.userId,
                credential.id, // Base64URL string
                Buffer.from(credential.publicKey), // Store as BLOB
                credential.counter,
                credential.transports ? JSON.stringify(credential.transports) : null,
                deviceName,
                deviceName
            );

            delete req.session.currentChallenge;
            res.json({ verified: true });
        } else {
            res.status(400).json({ error: '패스키 검증에 실패했습니다.' });
        }
    } catch (error: any) {
        console.error(error);
        res.status(400).json({ error: error.message });
    }
});

export default router;
