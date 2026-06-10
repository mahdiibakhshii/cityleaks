// PM2 process definition for the CityLeaks server.
// Runs `node --import tsx src/index.ts` as a single process so PM2 monitors the
// real app (accurate restarts/metrics) and NODE_OPTIONS/heap cap apply directly.
// tsx is the validated prod runner (no server compile step — see CLAUDE.md).
module.exports = {
  apps: [
    {
      name: 'cityleaks',
      cwd: '/opt/cityleaks/server',
      script: 'src/index.ts',
      interpreter: '/usr/local/bin/node',
      interpreter_args: '--import tsx',
      env: {
        PORT: '3000',
        NODE_ENV: 'production',
        UV_THREADPOOL_SIZE: '8',
        NODE_OPTIONS: '--max-old-space-size=1536',
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      // The leak grid / notes live in server/data (gitignored) and survive restarts.
    },
  ],
};
