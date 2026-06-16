import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true, // Expose on LAN so phones on the same network can connect.
    proxy: {
      // Proxy Socket.IO traffic to the game server during development.
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
      // Proxy REST API calls (e.g. the admin login) to the game server in dev.
      // In production the server serves both the client and /api on one origin.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // Admins' real-sticker photos are served by the game server from its data
      // dir; proxy them in dev so the admin/monitor/game pages can load them.
      '/note-images': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: {
      // Three pages: the game (index.html), the monitor, and the admin console.
      input: {
        main: 'index.html',
        monitor: 'monitor.html',
        admin: 'admin.html',
      },
    },
  },
});
