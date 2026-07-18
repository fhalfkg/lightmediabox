export interface VideoRecord {
    id: number;
    file_name: string;
    file_path: string;
    file_size: number;
    duration: number;
    resolution: string;
    video_codec: string;
    audio_codec: string;
    container_format: string;
    scanned_at: string;
    
    // 프론트엔드 전송을 위해 백엔드에서 동적으로 추가하는 필드
    thumbnail_url?: string;
}
