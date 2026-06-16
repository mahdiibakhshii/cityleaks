import { defineConfig, type Plugin } from 'vite';

// Dev-only: rewrite the QR short URL /c/:noteId → /chat.html so the chat page
// loads on the Vite dev server (in production Express handles this route). The
// chat client reads the noteId back from window.location.pathname.
function chatRouteRewrite(): Plugin {
  return {
    name: 'chat-route-rewrite',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/c\/[^/?#]+/.test(req.url)) {
          req.url = '/chat.html';
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [chatRouteRewrite()],
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
      // Four pages: the game (index.html), the monitor, the admin console,
      // and the per-note chat rooms served at /c/:noteId.
      input: {
        main: 'index.html',
        monitor: 'monitor.html',
        admin: 'admin.html',
        chat: 'chat.html',
      },
    },
  },
});
