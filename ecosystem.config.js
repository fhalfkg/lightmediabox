module.exports = {
    apps: [
        {
            name: 'lightmediabox',
            script: './dist/index.js',
            node_args: '--env-file=.env', // Node.js 자체 기능으로 .env 파일 로드
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: 'production'
            }
        }
    ]
};
