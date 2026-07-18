<div align="center">
  <img src="./public/icon.png" alt="LightMediaBox Icon" width="200" style="border-radius: 20px; margin-bottom: 20px;" />
  <h1>LightMediaBox</h1>
</div>

**LightMediaBox**는 오직 개인을 위해 설계된, 극도로 가볍고 빠른 개인용 미디어 서버입니다. 
복잡한 설정 없이 원하는 폴더를 지정하기만 하면 즉각적으로 스캔하여 브라우저에서 스트리밍할 수 있습니다.

## 핵심 기능 (Features)

* **초경량 자동 스캐너 (Task Queue)**: `chokidar`를 이용한 실시간 폴더 감시 시스템이 내장되어 있습니다. 대규모 라이브러리를 한 번에 처리할 수 있도록 **자동 작업 대기열(Task Queue)**이 파일의 메타데이터와 썸네일을 차례차례 안전하게 추출합니다.
* **패스키 로그인 강제**: 지문 인식, Face ID, Windows Hello 등을 이용한 로그인을 강제하여 보안성을 보장합니다. (최초 가입한 1인만 관리자로 등록됩니다)
* **HLS 및 Direct Play 스트리밍**: 브라우저 환경에 따라 원본 영상을 곧바로 재생하는 Direct Play 기능을 지원하며, 모바일이나 호환되지 않는 코덱일 경우 즉각적으로 HLS 트랜스코딩을 수행하여 재생합니다.
* **AirPlay & Chromecast 캐스트 지원**: 외부 기기에 안전한 1회용 스트리밍 토큰을 발급하여 클릭 한 번으로 스마트 TV나 Apple TV 등으로 영상을 송출할 수 있습니다.

## 설치 및 실행 방법 (Getting Started)

### 1. 요구 사항 (Prerequisites)
* **Node.js** (v18 이상 권장)
* **FFmpeg** (서버 구동 시 패키지를 통해 자동 설치되나, 시스템 환경에 따라 수동 설치가 필요할 수 있습니다)

### 2. 설치
```bash
npm install
```

### 3. 환경 변수 설정
프로젝트 루트에 `.env` 파일을 생성하고 아래와 같이 설정합니다.
```env
PORT=<원하는 포트 (Default는 3000)>
SESSION_SECRET=<세션 시크릿 키>
NODE_ENV=production
```

### 4. 실행
개발 환경:
```bash
npm run dev
```

운영 환경에서 빌드 후 실행:
```bash
npm run build
npm start
```

### (선택) PM2를 이용한 무중단 서비스 실행
`ecosystem.config.js`를 이용해 백그라운드 무중단 프로세스로 실행할 수 있습니다.
```bash
npm install -g pm2
npm run build
pm2 start ecosystem.config.js
```

## 참고 사항
- 본 프로젝트는 **개인용 미디어 서버**를 목적으로 개발되었으므로, 불특정 다수가 아닌 단 1명의 소유자를 기준으로 인증 체계가 작동합니다.
- 서버가 켜져 있는 동안 라이브러리 폴더 안으로 비디오 파일(.mp4, .mkv, .avi 등)을 옮기면 실시간으로 감지되어 라이브러리에 즉시 추가됩니다.
