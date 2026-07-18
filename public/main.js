// ─── 전역 커스텀 UI ───
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function showCustomDialog(options) {
    return new Promise((resolve) => {
        const dialog = document.getElementById('custom-dialog');
        const title = document.getElementById('dialog-title');
        const message = document.getElementById('dialog-message');
        const input = document.getElementById('dialog-input');
        const btnCancel = document.getElementById('btn-dialog-cancel');
        const btnConfirm = document.getElementById('btn-dialog-confirm');

        title.textContent = options.title || '알림';
        message.textContent = options.message || '';

        if (options.type === 'prompt') {
            input.style.display = 'block';
            input.value = options.defaultValue || '';
            input.focus();
        } else {
            input.style.display = 'none';
        }

        dialog.classList.add('visible');

        const cleanup = () => {
            dialog.classList.remove('visible');
            btnCancel.onclick = null;
            btnConfirm.onclick = null;
        };

        btnCancel.onclick = () => {
            cleanup();
            resolve(options.type === 'prompt' ? null : false);
        };

        btnConfirm.onclick = () => {
            cleanup();
            resolve(options.type === 'prompt' ? input.value : true);
        };
    });
}

const showConfirm = (title, message) => showCustomDialog({ type: 'confirm', title, message });
const showPrompt = (title, message, defaultValue) => showCustomDialog({ type: 'prompt', title, message, defaultValue });

// ─── DOM 요소 ───
const libraryView = document.getElementById('library-view');
const libraryGrid = document.getElementById('library-grid');
const btnBackFolder = document.getElementById('btn-back');
const currentPathEl = document.getElementById('current-path');

const playerView = document.getElementById('player-view');
const btnClosePlayer = document.getElementById('btn-close-player');

const videoPlayer = document.getElementById('video-player');
const playerWrapper = document.getElementById('player-wrapper');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const centerPlay = document.getElementById('center-play');
const btnLogout = document.getElementById('btn-logout');

const progressContainer = document.getElementById('progress-container');
const progressPlayed = document.getElementById('progress-played');
const progressBuffered = document.getElementById('progress-buffered');
const progressThumb = document.getElementById('progress-thumb');

const btnPlay = document.getElementById('btn-play');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');

const btnMute = document.getElementById('btn-mute');
const iconVol = document.getElementById('icon-vol');
const iconMuted = document.getElementById('icon-muted');
const volumeSlider = document.getElementById('volume-slider');

const timeDisplay = document.getElementById('time-display');

const btnQuality = document.getElementById('btn-quality');
const qualityMenu = document.getElementById('quality-menu');

const btnRepeat = document.getElementById('btn-repeat');

const btnFullscreen = document.getElementById('btn-fullscreen');
const btnPip = document.getElementById('btn-pip');
const iconFsEnter = document.getElementById('icon-fs-enter');
const iconFsExit = document.getElementById('icon-fs-exit');

// ─── 주요 상태 및 변수 ───
let hls = null;
let currentVideoId = null;
let currentQuality = null;
let qualities = [];
let isDirectPlaySupported = false;
let controlsTimeout = null;
let isSeeking = false;
let currentBrowsePath = '';
let isPlayerMode = false;
let isRepeat = false;

let currentViewMode = 'folder'; // 'folder' | 'video'
let currentSortBy = 'name'; // 'name' | 'duration' | 'size' | 'resolution'
let currentSortOrder = 'asc'; // 'asc' | 'desc'
let lastLoadedData = { folders: [], videos: [] };

const tabFolder = document.getElementById('tab-folder');
const tabVideo = document.getElementById('tab-video');
const sortSelect = document.getElementById('sort-select');
const btnSortOrder = document.getElementById('btn-sort-order');
const iconAsc = document.querySelector('.icon-asc');
const iconDesc = document.querySelector('.icon-desc');

// ─── 뷰 전환 로직 ───
function showLibrary() {
    isPlayerMode = false;
    document.body.classList.remove('player-mode');
    // 플레이어 정리
    if (hls) {
        hls.destroy();
        hls = null;
    }
    videoPlayer.pause();
    videoPlayer.removeAttribute('src');
    videoPlayer.load();

    playerView.classList.remove('visible');
    playerView.classList.add('hidden');
    libraryView.classList.remove('hidden');

    if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => { });
    }
}

function showPlayer() {
    isPlayerMode = true;
    document.body.classList.add('player-mode');
    libraryView.classList.add('hidden');
    playerView.classList.remove('hidden');
    playerView.classList.add('visible');
}

btnClosePlayer.onclick = showLibrary;

// ─── 정렬 헬퍼 ───
function getResolutionValue(resStr) {
    if (!resStr) return 0;
    const match = resStr.match(/(\d+)x(\d+)/);
    if (match) return parseInt(match[2], 10);
    return 0;
}

function sortVideos(videos) {
    return videos.slice().sort((a, b) => {
        let valA, valB;
        if (currentSortBy === 'name') {
            valA = a.file_name.toLowerCase();
            valB = b.file_name.toLowerCase();
        } else if (currentSortBy === 'duration') {
            valA = a.duration || 0;
            valB = b.duration || 0;
        } else if (currentSortBy === 'size') {
            valA = a.file_size || 0;
            valB = b.file_size || 0;
        } else if (currentSortBy === 'resolution') {
            valA = getResolutionValue(a.resolution);
            valB = getResolutionValue(b.resolution);
        }

        if (valA < valB) return currentSortOrder === 'asc' ? -1 : 1;
        if (valA > valB) return currentSortOrder === 'asc' ? 1 : -1;
        return 0;
    });
}

// ─── 데이터 로드 ───
async function loadLibrary() {
    libraryGrid.innerHTML = '<div class="empty-grid">불러오는 중...</div>';
    const pathBar = document.getElementById('path-bar');

    try {
        if (currentViewMode === 'folder') {
            pathBar.style.display = 'flex';
            if (currentBrowsePath) {
                btnBackFolder.style.display = 'flex';
                const parts = currentBrowsePath.split('/');
                currentPathEl.innerHTML = `📂 ${parts.join(' / ')}`;
            } else {
                btnBackFolder.style.display = 'none';
                currentPathEl.innerHTML = '📂 루트';
            }

            const res = await fetch(`/api/browse?path=${encodeURIComponent(currentBrowsePath)}`);
            if (res.status === 401) {
                checkAuthStatus();
                return;
            }
            lastLoadedData = await res.json();
        } else {
            pathBar.style.display = 'none';
            const res = await fetch(`/api/videos`);
            if (res.status === 401) {
                checkAuthStatus();
                return;
            }
            const allVideos = await res.json();
            lastLoadedData = { folders: [], videos: allVideos };
        }

        renderLibrary();
        hideLoading();
    } catch (err) {
        libraryGrid.innerHTML = '<div class="empty-grid">데이터를 불러올 수 없습니다.</div>';
        hideLoading();
    }
}

async function browsePath(targetPath) {
    currentBrowsePath = targetPath;
    currentViewMode = 'folder';
    updateTabsUI();

    const pathBar = document.getElementById('path-bar');
    pathBar.style.display = 'flex';
    if (currentBrowsePath) {
        btnBackFolder.style.display = 'flex';
        const parts = currentBrowsePath.split('/');
        currentPathEl.innerHTML = `📂 ${parts.join(' / ')}`;
    } else {
        btnBackFolder.style.display = 'none';
        currentPathEl.innerHTML = '📂 루트';
    }

    showLoading();
    try {
        const res = await fetch(`/api/browse?path=${encodeURIComponent(targetPath)}`);
        if (res.status === 401) {
            checkAuthStatus();
            return;
        }
        lastLoadedData = await res.json();
        renderLibrary();
        hideLoading();
    } catch (err) {
        libraryGrid.innerHTML = '<div class="empty-grid">데이터를 불러올 수 없습니다.</div>';
        hideLoading();
    }
}

// ─── 화면 렌더링 ───
function renderLibrary() {
    libraryGrid.innerHTML = '';
    const { folders, videos } = lastLoadedData;

    if (folders.length === 0 && videos.length === 0) {
        libraryGrid.innerHTML = '<div class="empty-grid">표시할 항목이 없습니다.</div>';
        return;
    }

    if (currentViewMode === 'folder') {
        // 폴더 카드
        folders.forEach(folder => {
            const card = document.createElement('div');
            card.className = 'media-card folder-card';

            let thumbHtml = '<div class="thumb-bg">📁</div>';

            if (folder.thumbnail_url) {
                const thumbUrl = folder.thumbnail_url + '?v=1';
                thumbHtml = `
                            <div class="fallback-icon">📁</div>
                            <div class="folder-badge">
                                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                                </svg>
                            </div>
                            <img class="thumb-bg" src="${thumbUrl}" alt="folder-thumbnail" onerror="this.parentElement.classList.add('no-thumb');">
                        `;
            }

            card.innerHTML = `
                        ${thumbHtml}
                        <div class="card-info">
                            <div class="card-title">${folder.name}</div>
                        </div>
                    `;
            card.onclick = () => browsePath(folder.path);
            libraryGrid.appendChild(card);
        });
    }

    // 비디오 카드 (정렬 적용)
    const sortedVideos = sortVideos(videos);
    sortedVideos.forEach(video => {
        const card = document.createElement('div');
        card.className = 'media-card video-card';

        let thumbHtml = '<div class="fallback-icon">🎬</div>';
        if (video.thumbnail_url) {
            thumbHtml += `<img class="thumb-bg" src="${video.thumbnail_url}?v=1" alt="thumbnail" onerror="this.parentElement.classList.add('no-thumb');">`;
        } else {
            card.classList.add('no-thumb');
        }

        card.innerHTML = `
                    ${thumbHtml}
                    <div class="card-info">
                        <div class="card-title">${video.file_name}</div>
                        <div class="card-meta">
                            <span>${formatTime(video.duration)}</span>
                            <span>${video.resolution}</span>
                        </div>
                    </div>
                `;

        card.onclick = () => selectVideo(video.id);
        libraryGrid.appendChild(card);
    });
}

function updateTabsUI() {
    if (currentViewMode === 'folder') {
        tabFolder.classList.add('active');
        tabVideo.classList.remove('active');
    } else {
        tabVideo.classList.add('active');
        tabFolder.classList.remove('active');
    }
}

// ─── 상단 UI 이벤트 리스너 ───
tabFolder.onclick = () => {
    currentViewMode = 'folder';
    updateTabsUI();
    loadLibrary();
};

tabVideo.onclick = () => {
    currentViewMode = 'video';
    updateTabsUI();
    loadLibrary();
};

sortSelect.onchange = (e) => {
    currentSortBy = e.target.value;
    renderLibrary();
};

btnSortOrder.onclick = () => {
    currentSortOrder = currentSortOrder === 'asc' ? 'desc' : 'asc';
    if (currentSortOrder === 'asc') {
        iconAsc.style.display = 'block';
        iconDesc.style.display = 'none';
    } else {
        iconAsc.style.display = 'none';
        iconDesc.style.display = 'block';
    }
    renderLibrary();
};

// 폴더 뒤로 가기
btnBackFolder.onclick = () => {
    if (!currentBrowsePath) return;
    const parent = currentBrowsePath.includes('/')
        ? currentBrowsePath.substring(0, currentBrowsePath.lastIndexOf('/'))
        : '';
    browsePath(parent);
};

// ─── 영상 선택 및 재생 ───
async function selectVideo(id) {
    currentVideoId = id;
    showPlayer();

    // 화질 목록 로드
    const res = await fetch(`/api/hls/${id}/qualities`);
    const data = await res.json();
    qualities = data.qualities || [];
    isDirectPlaySupported = data.isDirectPlaySupported || false;

    // 기본 화질: original
    loadQuality('original');
}

// ─── 화질 로드 (수동 전환 핵심 로직) ───
function loadQuality(quality) {
    const savedTime = videoPlayer.currentTime || 0;
    const wasPaused = videoPlayer.paused;

    currentQuality = quality;
    showLoading('화질 변환 중...');
    updateQualityMenu();

    // 기존 HLS 파괴
    if (hls) {
        hls.destroy();
        hls = null;
    }

    // 브라우저 비디오 디코더 완벽 초기화 (Safari 버그 방지)
    videoPlayer.removeAttribute('src');
    videoPlayer.load();

    // Direct Play 지원 여부에 따라 분기
    if (quality === 'original' && isDirectPlaySupported) {
        console.log('⚡ Direct Play 모드로 스트리밍 (TS 변환 없음)');
        videoPlayer.src = `/api/video/${currentVideoId}/direct?token=${window.streamToken || ''}`;
        if (savedTime > 0) {
            videoPlayer.currentTime = savedTime;
        }
        if (!wasPaused || savedTime === 0) {
            videoPlayer.play().catch(() => { });
        }

        // 실제 재생 가능해지면 로딩 해제
        const onCanPlay = () => {
            hideLoading();
            videoPlayer.removeEventListener('canplay', onCanPlay);
        };
        videoPlayer.addEventListener('canplay', onCanPlay);
        return;
    }

    // HLS 트랜스코딩 / 리먹싱 (Direct Play가 불가능하거나 480p 등을 선택한 경우)
    const m3u8Url = `/api/hls/${currentVideoId}/${quality}/index.m3u8?token=${window.streamToken || ''}`;

    // Safari(Mac/iOS)의 경우 네이티브 HLS 지원이 훨씬 안정적이므로 최우선으로 사용합니다.
    if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
        videoPlayer.src = m3u8Url;
        if (savedTime > 0) {
            videoPlayer.currentTime = savedTime;
        }
        videoPlayer.load();

        // Safari 네이티브의 경우 canplay 혹은 loadedmetadata 이후 재생 시도
        const onNativeCanPlay = () => {
            hideLoading();
            videoPlayer.removeEventListener('canplay', onNativeCanPlay);
            videoPlayer.removeEventListener('loadedmetadata', onNativeCanPlay);
            if (!wasPaused || savedTime === 0) {
                videoPlayer.play().catch(() => { });
            }
        };
        videoPlayer.addEventListener('canplay', onNativeCanPlay);
        videoPlayer.addEventListener('loadedmetadata', onNativeCanPlay);

    } else if (Hls.isSupported()) {
        hls = new Hls({
            startPosition: savedTime > 0 ? savedTime : -1,
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            maxBufferHole: 30,
            maxSeekHole: 30,
            enableWorker: true,
            lowLatencyMode: false
        });
        hls.loadSource(m3u8Url);
        hls.attachMedia(videoPlayer);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (!wasPaused || savedTime === 0) {
                videoPlayer.play().catch(() => { });
            }
        });

        const onCanPlay = () => {
            hideLoading();
            videoPlayer.removeEventListener('canplay', onCanPlay);
        };
        videoPlayer.addEventListener('canplay', onCanPlay);

        hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                console.error('HLS 치명적 오류:', data);
                hideLoading();
            }
        });
    }
}

// ─── 화질 메뉴 ───
function updateQualityMenu() {
    qualityMenu.querySelectorAll('.quality-option').forEach(el => el.remove());

    qualities.forEach(q => {
        const option = document.createElement('div');
        option.className = `quality-option${q.name === currentQuality ? ' active' : ''}`;
        option.innerHTML = `<span class="check">${q.name === currentQuality ? '✓' : ''}</span><span>${q.label}</span>`;
        option.onclick = (e) => {
            e.stopPropagation();
            if (q.name !== currentQuality) {
                loadQuality(q.name);
            }
            qualityMenu.classList.remove('visible');
        };
        qualityMenu.appendChild(option);
    });
}

btnQuality.onclick = (e) => {
    e.stopPropagation();
    qualityMenu.classList.toggle('visible');
};

document.addEventListener('click', () => {
    qualityMenu.classList.remove('visible');
});

// ─── 재생/정지 ───
function togglePlay() {
    if (!currentVideoId || !isPlayerMode) return;
    if (videoPlayer.paused) {
        videoPlayer.play().catch(() => { });
    } else {
        videoPlayer.pause();
    }
}

btnPlay.onclick = togglePlay;
centerPlay.onclick = togglePlay;
videoPlayer.addEventListener('click', togglePlay);

videoPlayer.addEventListener('play', () => {
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
    centerPlay.classList.remove('visible');
});

videoPlayer.addEventListener('pause', () => {
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
    centerPlay.classList.add('visible');
});

btnRepeat.onclick = () => {
    isRepeat = !isRepeat;
    if (isRepeat) {
        btnRepeat.classList.add('active');
    } else {
        btnRepeat.classList.remove('active');
    }
};

videoPlayer.addEventListener('ended', () => {
    if (isRepeat) {
        videoPlayer.currentTime = 0;
        videoPlayer.play();
    } else {
        iconPlay.style.display = 'block';
        iconPause.style.display = 'none';
        centerPlay.classList.add('visible');
    }
});

// ─── 볼륨 ───
btnMute.onclick = () => {
    videoPlayer.muted = !videoPlayer.muted;
    updateVolumeUI();
};

volumeSlider.oninput = () => {
    videoPlayer.volume = parseFloat(volumeSlider.value);
    videoPlayer.muted = videoPlayer.volume === 0;
    updateVolumeUI();
};

function updateVolumeUI() {
    const muted = videoPlayer.muted || videoPlayer.volume === 0;
    iconVol.style.display = muted ? 'none' : 'block';
    iconMuted.style.display = muted ? 'block' : 'none';
    if (!videoPlayer.muted) {
        volumeSlider.value = videoPlayer.volume;
    }
}

// ─── 프로그레스 바 ───
videoPlayer.addEventListener('timeupdate', () => {
    if (isSeeking || !isPlayerMode) return;
    updateProgress();
});

function updateProgress() {
    const duration = videoPlayer.duration || 0;
    const current = videoPlayer.currentTime || 0;
    if (duration > 0) {
        const pct = (current / duration) * 100;
        progressPlayed.style.width = pct + '%';
        progressThumb.style.left = pct + '%';
        timeDisplay.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    }

    if (videoPlayer.buffered.length > 0) {
        const buffEnd = videoPlayer.buffered.end(videoPlayer.buffered.length - 1);
        progressBuffered.style.width = (buffEnd / duration) * 100 + '%';
    }
}

progressContainer.addEventListener('mousedown', (e) => {
    isSeeking = true;
    seek(e);
    const onMove = (e) => seek(e);
    const onUp = () => {
        isSeeking = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
});

function seek(e) {
    const rect = progressContainer.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const duration = videoPlayer.duration || 0;
    videoPlayer.currentTime = pct * duration;
    progressPlayed.style.width = (pct * 100) + '%';
    progressThumb.style.left = (pct * 100) + '%';
    timeDisplay.textContent = `${formatTime(pct * duration)} / ${formatTime(duration)}`;
}

// ─── 전체화면 ───
btnFullscreen.onclick = toggleFullscreen;

if (btnPip) {
    btnPip.onclick = async () => {
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (videoPlayer.requestPictureInPicture) {
                await videoPlayer.requestPictureInPicture();
            } else if (videoPlayer.webkitSetPresentationMode) {
                videoPlayer.webkitSetPresentationMode(
                    videoPlayer.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture'
                );
            }
        } catch (err) {
            console.error('PIP 오류:', err);
            showToast('이 브라우저에서는 PIP 기능을 지원하지 않습니다.', 'error');
        }
    };
}

function toggleFullscreen() {
    const isIPhone = /iPhone|iPod/i.test(navigator.userAgent);

    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (isIPhone && videoPlayer.webkitEnterFullscreen) {
            // 아이폰은 비디오 태그 자체만 전체화면 가능
            videoPlayer.webkitEnterFullscreen();
        } else if (playerWrapper.requestFullscreen) {
            playerWrapper.requestFullscreen().catch(() => { });
        } else if (playerWrapper.webkitRequestFullscreen) {
            playerWrapper.webkitRequestFullscreen(); // 아이패드 및 Mac Safari
        } else if (videoPlayer.webkitEnterFullscreen) {
            videoPlayer.webkitEnterFullscreen(); // 예비용
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen().catch(() => { });
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen(); // Mac Safari
        }
    }
}

const handleFsChange = () => {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    iconFsEnter.style.display = isFs ? 'none' : 'block';
    iconFsExit.style.display = isFs ? 'block' : 'none';
};

document.addEventListener('fullscreenchange', handleFsChange);
document.addEventListener('webkitfullscreenchange', handleFsChange);

// ─── 컨트롤 자동 숨김 ───
playerWrapper.addEventListener('mousemove', () => {
    if (!isPlayerMode) return;
    playerWrapper.classList.add('controls-visible');
    clearTimeout(controlsTimeout);
    controlsTimeout = setTimeout(() => {
        if (!videoPlayer.paused && !qualityMenu.classList.contains('visible')) {
            playerWrapper.classList.remove('controls-visible');
        }
    }, 3000);
});

playerWrapper.addEventListener('mouseleave', () => {
    if (!videoPlayer.paused && isPlayerMode) {
        playerWrapper.classList.remove('controls-visible');
    }
});

// ─── 키보드 단축키 ───
document.addEventListener('keydown', (e) => {
    if (!isPlayerMode) return;

    // 플레이어 모드에서 ESC 누르면 라이브러리로 복귀 (전체화면 아닐 때만)
    if (e.key === 'Escape' && !document.fullscreenElement && !document.webkitFullscreenElement) {
        showLibrary();
        return;
    }

    switch (e.key) {
        case ' ':
            e.preventDefault();
            togglePlay();
            break;
        case 'ArrowLeft':
            e.preventDefault();
            videoPlayer.currentTime = Math.max(0, videoPlayer.currentTime - 5);
            break;
        case 'ArrowRight':
            e.preventDefault();
            videoPlayer.currentTime = Math.min(videoPlayer.duration, videoPlayer.currentTime + 5);
            break;
        case 'ArrowUp':
            e.preventDefault();
            videoPlayer.volume = Math.min(1, videoPlayer.volume + 0.1);
            volumeSlider.value = videoPlayer.volume;
            updateVolumeUI();
            break;
        case 'ArrowDown':
            e.preventDefault();
            videoPlayer.volume = Math.max(0, videoPlayer.volume - 0.1);
            volumeSlider.value = videoPlayer.volume;
            updateVolumeUI();
            break;
        case 'f':
        case 'F':
            toggleFullscreen();
            break;
        case 'm':
        case 'M':
            videoPlayer.muted = !videoPlayer.muted;
            updateVolumeUI();
            break;
        case 'p':
        case 'P':
            if (btnPip) btnPip.click();
            break;
    }
});

// ─── 유틸리티 ───
function formatTime(sec) {
    if (isNaN(sec) || sec < 0) return '0:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function showLoading(text) {
    loadingText.textContent = text || '로딩 중...';
    loadingOverlay.classList.add('visible');
}

function hideLoading() {
    loadingOverlay.classList.remove('visible');
}

// ─── 설정 로직 ───
const btnSettings = document.getElementById('btn-settings');
const settingsModal = document.getElementById('settings-modal');
const btnSettingsClose = document.getElementById('btn-settings-close');
const btnSettingsSave = document.getElementById('btn-settings-save');
const inputMediaDir = document.getElementById('input-media-dir');

// 탭 전환 로직
const settingsTabs = document.querySelectorAll('.settings-tab');
const settingsPanes = document.querySelectorAll('.settings-pane');

settingsTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        settingsTabs.forEach(t => t.classList.remove('active'));
        settingsPanes.forEach(p => p.classList.remove('active'));

        tab.classList.add('active');
        document.getElementById(tab.dataset.target).classList.add('active');
    });
});

// 패스키 포맷 헬퍼
function formatDate(dateStr) {
    const d = new Date(dateStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function loadAccountInfo() {
    const displayUsername = document.getElementById('display-username');
    const passkeysContainer = document.getElementById('passkeys-list-container');

    try {
        passkeysContainer.innerHTML = '<div style="color: #a1a1aa; font-size: 13px;">불러오는 중...</div>';
        const res = await fetch('/api/auth/account-info');
        if (!res.ok) throw new Error('계정 정보를 불러올 수 없습니다.');
        const data = await res.json();

        displayUsername.value = data.username;
        const changePwdUsername = document.getElementById('change-pwd-username');
        if (changePwdUsername) changePwdUsername.value = data.username;

        if (data.passkeys && data.passkeys.length > 0) {
            let html = '<ul style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px;">';
            const isOnlyOne = data.passkeys.length === 1;

            function getIcon(deviceName) {
                const d = deviceName.toLowerCase();
                if (d.includes('iphone') || d.includes('ipad') || d.includes('android')) {
                    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="color: #a78bfa; margin-right: 8px; flex-shrink: 0;"><path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"/></svg>`;
                } else if (d.includes('mac') || d.includes('windows') || d.includes('linux')) {
                    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="color: #a78bfa; margin-right: 8px; flex-shrink: 0;"><path d="M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H3V4h18v12z"/></svg>`;
                } else {
                    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="color: #a78bfa; margin-right: 8px; flex-shrink: 0;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`;
                }
            }

            data.passkeys.forEach((pk, index) => {
                const disabledAttr = isOnlyOne ? 'disabled' : '';
                const disabledStyle = isOnlyOne ? 'opacity: 0.3; cursor: not-allowed; border-color: transparent;' : 'color: #ef4444; border-color: rgba(239, 68, 68, 0.3);';

                html += `
                            <li style="display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.05); padding: 8px 12px; border-radius: 6px;">
                                <div style="display: flex; align-items: center;">
                                    ${getIcon(pk.device_name)}
                                    <div>
                                        <div style="font-size: 14px; color: #fff; font-weight: 500;">${pk.name}</div>
                                        <div style="font-size: 12px; color: #a1a1aa;">등록일: ${formatDate(pk.created_at)}</div>
                                    </div>
                                </div>
                                <div style="display: flex; gap: 6px;">
                                    <button class="btn-rename-passkey btn-secondary" data-id="${pk.id}" data-name="${pk.name}" style="padding: 4px 8px; font-size: 12px;">이름 변경</button>
                                    <button class="btn-delete-passkey btn-secondary" data-id="${pk.id}" ${disabledAttr} style="padding: 4px 8px; font-size: 12px; ${disabledStyle}">삭제</button>
                                </div>
                            </li>
                        `;
            });
            html += '</ul>';
            passkeysContainer.innerHTML = html;

            // 삭제 이벤트 바인딩
            document.querySelectorAll('.btn-delete-passkey').forEach(btn => {
                btn.onclick = async () => {
                    if (!(await showConfirm('패스키 삭제', '정말 이 패스키를 삭제하시겠습니까?'))) return;
                    try {
                        const delRes = await fetch(`/api/auth/passkeys/${btn.dataset.id}`, { method: 'DELETE' });
                        const delData = await delRes.json();
                        if (delData.success) {
                            loadAccountInfo(); // 재렌더링
                        } else {
                            showToast(delData.error || '삭제 실패', 'error');
                        }
                    } catch (err) {
                        showToast('패스키 삭제 중 오류가 발생했습니다.', 'error');
                    }
                };
            });

            // 이름 변경 이벤트 바인딩
            document.querySelectorAll('.btn-rename-passkey').forEach(btn => {
                btn.onclick = async () => {
                    const currentName = btn.dataset.name;
                    const newName = await showPrompt('이름 변경', '새로운 패스키 이름을 입력하세요:', currentName);
                    if (newName === null || newName.trim() === '') return;
                    if (newName.trim() === currentName) return;

                    try {
                        const res = await fetch(`/api/auth/passkeys/${btn.dataset.id}/name`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: newName })
                        });
                        const data = await res.json();
                        if (data.success) {
                            loadAccountInfo();
                        } else {
                            showToast(data.error || '이름 변경 실패', 'error');
                        }
                    } catch (err) {
                        showToast('이름 변경 중 오류가 발생했습니다.', 'error');
                    }
                };
            });
        } else {
            passkeysContainer.innerHTML = '<div style="color: #a1a1aa; font-size: 13px;">등록된 패스키가 없습니다.</div>';
        }
    } catch (err) {
        console.error(err);
        passkeysContainer.innerHTML = '<div style="color: #ef4444; font-size: 13px;">오류가 발생했습니다.</div>';
    }
}

const btnAddPasskey = document.getElementById('btn-add-passkey');
if (btnAddPasskey) {
    btnAddPasskey.onclick = async () => {
        try {
            const optRes = await fetch('/api/auth/passkey/add-options');
            const optData = await optRes.json();

            if (optData.error) return showToast(optData.error, 'error');

            let attResp;
            try {
                attResp = await SimpleWebAuthnBrowser.startRegistration(optData);
            } catch (error) {
                if (error.name === 'NotAllowedError') {
                    return showToast('패스키 생성이 취소되었습니다.', 'info');
                }
                throw error;
            }

            const verRes = await fetch('/api/auth/passkey/add-verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(attResp)
            });
            const verData = await verRes.json();
            if (verData.verified) {
                showToast('새 패스키가 추가되었습니다!', 'success');
                loadAccountInfo();
            } else {
                showToast('패스키 등록 실패: ' + (verData.error || '알 수 없는 오류'), 'error');
            }
        } catch (err) {
            console.error(err);
            showToast('패스키 생성 중 오류가 발생했습니다.', 'error');
        }
    };
}

const formChangePassword = document.getElementById('form-change-password');
if (formChangePassword) {
    formChangePassword.onsubmit = async (e) => {
        e.preventDefault();
        document.activeElement?.blur();

        const currentPassword = document.getElementById('current-password').value;
        const newPassword = document.getElementById('new-password').value;

        try {
            const res = await fetch('/api/auth/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword })
            });
            const data = await res.json();

            if (data.success) {
                formChangePassword.submit(); // 비밀번호 변경 성공 시에만 브라우저 암호 업데이트 유도
                showToast('비밀번호가 성공적으로 변경되었습니다.', 'success');
                document.getElementById('current-password').value = '';
                document.getElementById('new-password').value = '';
            } else {
                showToast('비밀번호 변경 실패: ' + (data.error || '알 수 없는 오류'), 'error');
            }
        } catch (err) {
            console.error(err);
            showToast('비밀번호 변경 중 오류가 발생했습니다.', 'error');
        }
    };
}

btnSettings.onclick = async () => {
    try {
        const res = await fetch('/api/config');
        const config = await res.json();
        inputMediaDir.value = config.mediaDir || '';

        // 설정 창 열릴 때 계정 정보도 함께 로드
        loadAccountInfo();

        settingsModal.classList.add('visible');
    } catch (err) {
        console.error('설정 로드 실패', err);
    }
};

btnSettingsClose.onclick = () => {
    settingsModal.classList.remove('visible');
};

btnSettingsSave.onclick = async () => {
    const newDir = inputMediaDir.value.trim();
    if (!newDir) return showToast('경로를 입력해주세요.', 'error');

    try {
        showLoading('경로를 변경하고 스캔하는 중입니다...');
        settingsModal.classList.remove('visible');

        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mediaDir: newDir })
        });

        const data = await res.json();
        if (data.success) {
            // 성공 시 뷰 전환(폴더뷰로) 및 초기 경로 재로드
            currentViewMode = 'folder';
            updateTabsUI();
            browsePath('');
        } else {
            showToast('경로 변경 실패: ' + (data.error || '알 수 없는 오류'), 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('설정 저장 중 오류가 발생했습니다: ' + err.message, 'error');
    } finally {
        hideLoading();
    }
};

// ─── 시스템 폴더 브라우저 ───
const btnBrowsePath = document.getElementById('btn-browse-path');
const systemBrowser = document.getElementById('system-browser');

btnBrowsePath.onclick = (e) => {
    e.preventDefault();
    if (systemBrowser.style.display === 'flex') {
        systemBrowser.style.display = 'none';
    } else {
        systemBrowser.style.display = 'flex';
        loadSystemBrowse(inputMediaDir.value);
    }
};

async function loadSystemBrowse(targetPath) {
    systemBrowser.innerHTML = '<div style="color:#a1a1aa; font-size:13px; text-align:center; padding:16px;">로딩 중...</div>';
    try {
        const res = await fetch(`/api/system-browse?path=${encodeURIComponent(targetPath || '')}`);
        if (!res.ok) throw new Error('경로를 불러올 수 없습니다.');
        const data = await res.json();

        // 폴더 이동 시 실시간으로 경로 입력창 업데이트
        if (data.currentPath) {
            inputMediaDir.value = data.currentPath;
        }

        systemBrowser.innerHTML = '';

        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.borderBottom = '1px solid rgba(255,255,255,0.1)';
        header.style.paddingBottom = '8px';
        header.style.marginBottom = '8px';
        header.style.gap = '8px';

        const currentPathSpan = document.createElement('span');
        currentPathSpan.style.fontSize = '12px';
        currentPathSpan.style.color = '#a78bfa';
        currentPathSpan.style.wordBreak = 'break-all';
        currentPathSpan.style.fontWeight = '600';
        currentPathSpan.textContent = data.currentPath || '내 PC (드라이브 목록)';

        header.appendChild(currentPathSpan);
        systemBrowser.appendChild(header);

        if (data.parentPath !== null) {
            const upBtn = document.createElement('div');
            upBtn.className = 'browser-item';
            upBtn.innerHTML = '<span>📁</span> <span>.. (상위 폴더)</span>';
            upBtn.onclick = () => loadSystemBrowse(data.parentPath);
            systemBrowser.appendChild(upBtn);
        }

        data.folders.forEach(f => {
            const fBtn = document.createElement('div');
            fBtn.className = 'browser-item';
            fBtn.innerHTML = `<span>📁</span> <span>${f.name}</span>`;
            fBtn.onclick = () => loadSystemBrowse(f.path);
            systemBrowser.appendChild(fBtn);
        });

        if (data.folders.length === 0 && data.parentPath === null && data.currentPath) {
            const emptyMsg = document.createElement('div');
            emptyMsg.style.color = '#71717a';
            emptyMsg.style.fontSize = '12px';
            emptyMsg.style.padding = '8px';
            emptyMsg.style.textAlign = 'center';
            emptyMsg.textContent = '폴더가 없습니다.';
            systemBrowser.appendChild(emptyMsg);
        }

    } catch (err) {
        systemBrowser.innerHTML = '<div style="color:#ef4444; font-size:13px; text-align:center; padding:16px;">경로를 불러올 수 없거나 권한이 없습니다.</div>';
    }
}

// ─── 인증 및 온보딩 로직 ───
const authView = document.getElementById('auth-view');
const authSetupForm = document.getElementById('auth-setup-form');
const authLoginForm = document.getElementById('auth-login-form');

const formRegister = document.getElementById('form-register');
const formLogin = document.getElementById('form-login');

async function checkAuthStatus() {
    try {
        const res = await fetch('/api/auth/session');
        const data = await res.json();

        if (data.loggedIn) {
            authView.classList.add('hidden');
            libraryView.classList.remove('hidden');

            try {
                const tokenRes = await fetch('/api/auth/stream-token');
                const tokenData = await tokenRes.json();
                window.streamToken = tokenData.token;
            } catch (e) {
                console.error('스트리밍 토큰 발급 실패', e);
            }

            // 모바일 사파리 등에서 로그인 시 OS 키보드/줌 때문에 내려간 스크롤을 최상단으로 복구
            // WebAuthn UI 종료 및 화면 렌더링 후 적용되도록 충분한 지연 시간 확보 (300ms)
            setTimeout(() => window.scrollTo(0, 0), 300);

            if (currentViewMode === 'folder') {
                browsePath('');
            } else {
                loadLibrary();
            }
        } else {
            // Not logged in. Check setup status.
            authView.classList.remove('hidden');
            libraryView.classList.add('hidden');

            const setupRes = await fetch('/api/auth/setup-status');
            const setupData = await setupRes.json();

            if (setupData.isSetup) {
                authSetupForm.style.display = 'none';
                authLoginForm.style.display = 'block';
            } else {
                authSetupForm.style.display = 'block';
                authLoginForm.style.display = 'none';
            }
        }
    } catch (err) {
        console.error('인증 상태 확인 실패', err);
    }
}

formRegister.onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById('reg-username').value;
    const password = document.getElementById('reg-password').value;

    try {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.success) {
            showToast('관리자 계정이 생성되었습니다. 이제 로그인 후 패스키를 등록해주세요.', 'info');
            checkAuthStatus();
        } else {
            showToast(data.error || '회원가입 실패', 'error');
        }
    } catch (err) {
        showToast('회원가입 요청 중 오류가 발생했습니다.', 'error');
    }
};

formLogin.onsubmit = async (e) => {
    e.preventDefault();
    document.activeElement?.blur();

    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (data.success && data.require2FA) {
            formLogin.submit(); // 로그인 성공 시에만 브라우저 암호 저장 유도
            
            const { SimpleWebAuthnBrowser } = window;
            if (!data.hasPasskey) {
                // 최초 로그인: 패스키 등록
                showToast('최초 1회 2단계 인증용 패스키를 등록해야 합니다.', 'info');
                const optRes = await fetch('/api/auth/passkey/register-options');
                const optData = await optRes.json();

                let attResp;
                try {
                    attResp = await SimpleWebAuthnBrowser.startRegistration(optData);
                } catch (error) {
                    if (error.name === 'NotAllowedError') {
                        return showToast('패스키 등록이 취소되었습니다.', 'info');
                    }
                    throw error;
                }

                const verRes = await fetch('/api/auth/passkey/register-verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(attResp)
                });
                const verData = await verRes.json();
                if (verData.verified) {
                    showToast('패스키 등록 및 로그인이 완료되었습니다!', 'success');
                    checkAuthStatus();
                } else {
                    showToast('패스키 등록 실패: ' + (verData.error || '알 수 없는 오류'), 'error');
                }
            } else {
                // 패스키 인증
                const optRes = await fetch('/api/auth/passkey/auth-options');
                const optData = await optRes.json();

                let asseResp;
                try {
                    asseResp = await SimpleWebAuthnBrowser.startAuthentication(optData);
                } catch (error) {
                    if (error.name === 'NotAllowedError') {
                        return showToast('패스키 인증이 취소되었습니다.', 'info');
                    }
                    throw error;
                }

                const verRes = await fetch('/api/auth/passkey/auth-verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(asseResp)
                });
                const verData = await verRes.json();
                if (verData.verified) {
                    checkAuthStatus();
                } else {
                    showToast('패스키 인증 실패: ' + (verData.error || '알 수 없는 오류'), 'error');
                }
            }
        } else {
            showToast(data.error || '로그인 실패', 'error');
        }
    } catch (err) {
        showToast('로그인 요청 중 오류가 발생했습니다.', 'error');
        console.error(err);
    }
};

btnLogout.onclick = async () => {
    if (await showConfirm('로그아웃', '로그아웃하시겠습니까?')) {
        await fetch('/api/auth/logout', { method: 'POST' });
        checkAuthStatus();
    }
};

// 앱 초기화 시작
checkAuthStatus();

// ─── AirPlay & Chromecast 지원 ───

const btnAirplay = document.getElementById('btn-airplay');
const btnCastWrapper = document.getElementById('btn-cast-wrapper');

// 1. AirPlay (Safari 전용)
if (window.WebKitPlaybackTargetAvailabilityEvent) {
    videoPlayer.addEventListener('webkitplaybacktargetavailabilitychanged', function(event) {
        if (event.availability === 'available') {
            btnAirplay.style.display = 'block';
        } else {
            btnAirplay.style.display = 'none';
        }
    });

    btnAirplay.addEventListener('click', function() {
        videoPlayer.webkitShowPlaybackTargetPicker();
    });
}

// 2. Google Cast (Chromecast)
let castSession = null;

window.__onGCastApiAvailable = function(isAvailable) {
    if (isAvailable) {
        initializeCastApi();
    }
};

function initializeCastApi() {
    cast.framework.CastContext.getInstance().setOptions({
        receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    });

    btnCastWrapper.style.display = 'inline-block';

    const context = cast.framework.CastContext.getInstance();
    context.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, function(event) {
        if (event.sessionState === cast.framework.SessionState.SESSION_STARTED || event.sessionState === cast.framework.SessionState.SESSION_RESUMED) {
            castSession = context.getCurrentSession();
            castCurrentVideo();
        } else if (event.sessionState === cast.framework.SessionState.SESSION_ENDED) {
            castSession = null;
        }
    });
}

function castCurrentVideo() {
    if (!castSession || !currentVideoId) return;

    const origin = window.location.origin;
    let url = '';
    
    // HLS.js나 native 플레이어에 공급되는 url과 동일하게 전송
    if (currentQuality === 'original') {
        url = `${origin}/api/video/${currentVideoId}/direct?token=${window.streamToken || ''}`;
    } else {
        url = `${origin}/api/hls/${currentVideoId}/${currentQuality}/index.m3u8?token=${window.streamToken || ''}`;
    }

    const mediaInfo = new chrome.cast.media.MediaInfo(url, currentQuality === 'original' ? 'video/mp4' : 'application/x-mpegURL');
    
    const videoData = allVideos.find(v => String(v.id) === String(currentVideoId));
    if (videoData) {
        const metadata = new chrome.cast.media.GenericMediaMetadata();
        metadata.title = videoData.file_name;
        mediaInfo.metadata = metadata;
    }

    const request = new chrome.cast.media.LoadRequest(mediaInfo);
    request.currentTime = videoPlayer.currentTime;

    castSession.loadMedia(request).then(
        function() { 
            console.log('✅ 크롬캐스트로 전송 완료'); 
            videoPlayer.pause();
        },
        function(e) { console.error('❌ 크롬캐스트 전송 에러', e); }
    );
}
