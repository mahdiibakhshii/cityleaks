import './styles/main.css';
import { MonitorApp } from './monitor/MonitorApp';

const app = new MonitorApp();
app.start();

// Expose for debugging in the console.
(window as unknown as { monitor: MonitorApp }).monitor = app;
