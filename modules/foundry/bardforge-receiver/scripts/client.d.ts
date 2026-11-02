export type TransportState =
  'idle' | 'connecting' | 'waiting' | 'live' | 'reconnecting' | 'auth-error' | 'error';
export interface TransportStatus {
  state: TransportState;
  listeners: number;
}
export interface TransportOptions {
  url: string;
  room: string;
  token: string;
  role: 'publisher' | 'listener';
  stream?: MediaStream;
  iceServers?: RTCIceServer[];
  relayOnly?: boolean;
  onState?: (status: TransportStatus) => void;
  onStream?: (stream: MediaStream | null) => void;
}
export function validateConnection(options: TransportOptions): string;
export class RelayAudioClient {
  constructor(options: TransportOptions);
  start(): void;
  stop(): void;
  readonly running: boolean;
}
