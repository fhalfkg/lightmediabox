import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import path from 'path';
import './db'; // 임포트하는 순간 내부의 db.exec()가 실행되어 테이블이 생성됨
import { startScanner } from './scanner';
import routes from './routes';
import authRoutes from './auth';
import db from './db';
import jwt from 'jsonwebtoken';

const SqliteStore = require('better-sqlite3-session-store')(session);

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // express-rate-limit 프록시 헤더 신뢰
app.use(express.json()); // JSON 바디 파싱을 위해 추가

app.use(session({
    store: new SqliteStore({
        client: db,
        expired: {
            clear: true,
            intervalMs: 15 * 60 * 1000
        }
    }),
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: true,
        sameSite: 'lax',
    }
}));

// API Auth 라우터 등록
app.use('/api/auth', authRoutes);

// API 보안 미들웨어 (인증되지 않은 요청 차단)
app.use('/api', (req, res, next) => {
    if (req.session.userId) {
        return next();
    }

    const token = req.query.token as string;
    if (token) {
        try {
            const secret = process.env.SESSION_SECRET || 'default_secret_key';
            jwt.verify(token, secret);
            return next();
        } catch (err) {
            return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
        }
    }

    return res.status(401).json({ error: '인증이 필요합니다.' });
});

// 스캐너 실행
startScanner();

app.use(express.static(path.join(process.cwd(), 'public')));

// 일반 API 라우터 등록
app.use('/api', routes);

app.get('/', (req, res) => {
    res.send('LightMediaBox HLS Server is running! 영상을 보려면 /api/videos 를 확인하세요.');
});

app.listen(PORT, () => {
    console.log(`🚀 미디어 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
