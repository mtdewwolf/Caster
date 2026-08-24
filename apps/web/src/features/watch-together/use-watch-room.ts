import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  WatchRoomPreferences,
  WatchRoomServerMessage,
  WatchRoomSnapshot,
  WatchRoomTimeline,
  WatchRoomTimelineCause
} from './contracts';

interface TimelineEvent {
  timeline: WatchRoomTimeline;
  cause: WatchRoomTimelineCause;
  sequence: number;
}

export interface WatchRoomConnectionState {
  connected: boolean;
  room: WatchRoomSnapshot | null;
  timelineEvent: TimelineEvent | null;
  error: string | null;
  sendCommand(action: 'play' | 'pause' | 'seek', positionSeconds: number): void;
  sendHostReport(revision: number, positionSeconds: number, paused: boolean): void;
  sendPreferences(preferences: Partial<WatchRoomPreferences>): void;
}

function socketUrl(roomId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/watch-rooms/${encodeURIComponent(roomId)}/ws`;
}

function isServerMessage(value: unknown): value is WatchRoomServerMessage {
  return Boolean(value) && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
}

export function useWatchRoom(roomId: string | null): WatchRoomConnectionState {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const sequenceRef = useRef(0);
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState<WatchRoomSnapshot | null>(null);
  const [timelineEvent, setTimelineEvent] = useState<TimelineEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let reconnectAttempt = 0;

    const connect = () => {
      if (!active || !roomId) return;
      const socket = new WebSocket(socketUrl(roomId));
      socketRef.current = socket;

      socket.onopen = () => {
        reconnectAttempt = 0;
        setConnected(true);
        setError(null);
        socket.send(JSON.stringify({ type: 'ping', clientTimeMs: Date.now() }));
      };
      socket.onmessage = (event) => {
        let message: unknown;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!isServerMessage(message)) return;
        switch (message.type) {
          case 'snapshot':
            setRoom(message.room);
            setTimelineEvent({
              timeline: message.room.timeline,
              cause: 'snapshot',
              sequence: ++sequenceRef.current
            });
            return;
          case 'timeline':
            setRoom((current) => current ? { ...current, timeline: message.timeline } : current);
            setTimelineEvent({
              timeline: message.timeline,
              cause: message.cause,
              sequence: ++sequenceRef.current
            });
            return;
          case 'presence':
            setRoom((current) => current ? {
              ...current,
              hostUserId: message.hostUserId,
              participants: message.participants,
              self: {
                ...current.self,
                role: current.self.userId === message.hostUserId ? 'host' : 'member',
                connected: message.participants.find(
                  (participant) => participant.userId === current.self.userId
                )?.connected ?? current.self.connected
              }
            } : current);
            return;
          case 'preferences':
            setRoom((current) => current ? {
              ...current, self: { ...current.self, preferences: message.preferences }
            } : current);
            return;
          case 'error':
            setError(message.message);
            return;
          case 'pong':
            return;
        }
      };
      socket.onclose = (event) => {
        if (socketRef.current === socket) socketRef.current = null;
        setConnected(false);
        if (!active || event.code === 4000 || event.code === 4003 || event.code === 4004) {
          if (event.reason) setError(event.reason);
          return;
        }
        reconnectAttempt += 1;
        const delay = Math.min(10_000, 500 * 2 ** Math.min(reconnectAttempt, 5));
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };
      socket.onerror = () => setError('Watch room connection was interrupted');
    };

    setRoom(null);
    setTimelineEvent(null);
    setError(null);
    if (roomId) connect();
    return () => {
      active = false;
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Player closed');
      setConnected(false);
    };
  }, [roomId]);

  const send = useCallback((message: object) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  return {
    connected,
    room,
    timelineEvent,
    error,
    sendCommand: useCallback((action, positionSeconds) => {
      send({ type: 'command', action, positionSeconds });
    }, [send]),
    sendHostReport: useCallback((revision, positionSeconds, paused) => {
      send({ type: 'host-report', revision, positionSeconds, paused });
    }, [send]),
    sendPreferences: useCallback((preferences) => {
      send({ type: 'preferences', ...preferences });
    }, [send])
  };
}
