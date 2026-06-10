import type { Server, Socket } from 'socket.io';
import { EVENTS } from '../../shared/protocol';
import { LeakGrid } from './LeakGrid';
import { GRID_FILE } from './config';

/**
 * Handles the TouchDesigner room: sends the full grid on connect,
 * streams deltas each tick, and responds to reset requests.
 */
export class TDRoom {
  private io: Server;

  constructor(io: Server) {
    this.io = io;
  }

  /** Called when a TD client connects. Sends the full grid + current stats. */
  onConnect(socket: Socket, leakGrid: LeakGrid, playerCount: number): void {
    console.log('TouchDesigner connected:', socket.id);

    socket.emit(EVENTS.GRID_FULL, leakGrid.getFullBuffer());
    socket.emit(EVENTS.GRID_STATS, {
      totalLeaked: leakGrid.getLeakedCount(),
      percentage: leakGrid.getPercentage(),
      playerCount,
    });

    socket.on(EVENTS.GRID_RESET, () => {
      console.log('Grid reset requested by TD');
      leakGrid.reset();
      leakGrid.saveToDisk(GRID_FILE);
      // Broadcast the cleared grid to all TD clients.
      this.io.to('td').emit(EVENTS.GRID_FULL, leakGrid.getFullBuffer());
    });

    socket.on('disconnect', () => {
      console.log('TouchDesigner disconnected:', socket.id);
    });
  }

  /** Called each server tick with newly marked cell indices. */
  sendDelta(newCells: number[]): void {
    this.io.to('td').emit(EVENTS.GRID_DELTA, { cells: newCells });
  }

  /**
   * Push a cleared grid to the TD room (after an admin reset, which clears the
   * shared LeakGrid). TD clients re-snapshot from the empty buffer.
   */
  sendReset(leakGrid: LeakGrid): void {
    this.io.to('td').emit(EVENTS.GRID_FULL, leakGrid.getFullBuffer());
  }

  /** Send a stats update to the TD room. */
  sendStats(leakGrid: LeakGrid, playerCount: number): void {
    this.io.to('td').emit(EVENTS.GRID_STATS, {
      totalLeaked: leakGrid.getLeakedCount(),
      percentage: leakGrid.getPercentage(),
      playerCount,
    });
  }
}
