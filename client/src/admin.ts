import './styles/main.css';
import { AdminApp } from './admin/AdminApp';

const app = new AdminApp();
app.start();

// Expose for debugging in the console.
(window as unknown as { admin: AdminApp }).admin = app;
