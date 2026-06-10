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
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: {
      // Two pages: the game (index.html) and the monitor (monitor.html).
      input: {
        main: 'index.html',
        monitor: 'monitor.html',
      },
    },
  },
});
