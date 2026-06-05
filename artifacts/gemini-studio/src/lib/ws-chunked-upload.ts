/**
 * WebSocket-based chunked file upload with automatic reconnection and resume.
 * Supports files up to 2GB+ with persistent connection (no HTTP timeouts).
 */

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
const WS_HEARTBEAT_INTERVAL = 25_000; // 25 seconds (server pings every 25s)
const RECONNECT_DELAY = 2000; // 2 seconds
const MAX_RECONNECT_ATTEMPTS = 5;

interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  percentage: number;
  chunksCompleted: number;
  totalChunks: number;
  currentChunk: number;
}

interface UploadOptions {
  file: File;
  projectId: string;
  onProgress?: (progress: UploadProgress) => void;
  onError?: (error: string) => void;
  onSuccess?: (filePath: string) => void;
}

class WSChunkedUploader {
  private ws: WebSocket | null = null;
  private file: File | null = null;
  private uploadId: string = '';
  private projectId: string = '';
  private totalChunks: number = 0;
  private uploadedChunks: Set<number> = new Set();
  private onProgress: ((progress: UploadProgress) => void) | null = null;
  private onError: ((error: string) => void) | null = null;
  private onSuccess: ((filePath: string) => void) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private reconnectAttempts: number = 0;
  private isShuttingDown: boolean = false;
  private wsUrl: string = '';

  constructor() {
    this.wsUrl = this.getWSUrl();
  }

  private getWSUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return `${protocol}//${host}/api/upload-ws`;
  }

  async upload(options: UploadOptions): Promise<string> {
    this.file = options.file;
    this.projectId = options.projectId;
    this.onProgress = options.onProgress || null;
    this.onError = options.onError || null;
    this.onSuccess = options.onSuccess || null;
    this.uploadId = `${options.projectId}-${Date.now()}`;
    this.totalChunks = Math.ceil(this.file.size / CHUNK_SIZE);
    this.uploadedChunks.clear();
    this.reconnectAttempts = 0;
    this.isShuttingDown = false;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.shutdown();
        reject(new Error('Upload timeout: no connection established after 30s'));
      }, 30_000);

      const originalOnSuccess = this.onSuccess;
      this.onSuccess = (filePath: string) => {
        clearTimeout(timeoutId);
        originalOnSuccess?.(filePath);
        resolve(filePath);
      };

      const originalOnError = this.onError;
      this.onError = (error: string) => {
        clearTimeout(timeoutId);
        originalOnError?.(error);
        reject(new Error(error));
      };

      this.connect();
    });
  }

  private connect(): void {
    if (this.isShuttingDown) return;

    try {
      console.log('[v0] WS connecting to:', this.wsUrl);
      this.ws = new WebSocket(this.wsUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        console.log('[v0] WS connected');
        this.reconnectAttempts = 0;
        this.sendInit();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data);
      };

      this.ws.onerror = (error: Event) => {
        console.error('[v0] WS error:', error);
      };

      this.ws.onclose = () => {
        console.log('[v0] WS closed');
        if (!this.isShuttingDown && this.uploadedChunks.size < this.totalChunks) {
          this.attemptReconnect();
        }
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Connection failed';
      console.error('[v0] WS creation failed:', msg);
      this.onError?.(msg);
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      const msg = `Failed to upload after ${MAX_RECONNECT_ATTEMPTS} reconnection attempts`;
      console.error('[v0]', msg);
      this.onError?.(msg);
      return;
    }

    this.reconnectAttempts++;
    console.log(`[v0] Reconnecting (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    setTimeout(() => this.connect(), RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1));
  }

  private sendInit(): void {
    if (!this.file || !this.ws) return;

    const initMsg = {
      type: 'init',
      uploadId: this.uploadId,
      projectId: this.projectId,
      fileName: this.file.name,
      fileSize: this.file.size,
      totalChunks: this.totalChunks,
    };

    this.ws.send(JSON.stringify(initMsg));
  }

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      console.log('[v0] WS message:', msg.type);

      if (msg.type === 'ready') {
        this.startUpload();
      } else if (msg.type === 'chunk-ack') {
        this.handleChunkAck(msg.chunkIndex);
      } else if (msg.type === 'assembled') {
        this.shutdown();
        this.onSuccess?.(msg.filePath);
      } else if (msg.type === 'error') {
        this.shutdown();
        this.onError?.(msg.error || 'Server error');
      } else if (msg.type === 'status') {
        console.log('[v0] Upload status:', msg);
      }
    } catch (error) {
      console.error('[v0] Failed to parse WS message:', error);
    }
  }

  private startUpload(): void {
    console.log('[v0] Starting chunk upload, total chunks:', this.totalChunks);
    for (let i = 0; i < this.totalChunks; i++) {
      this.enqueue(() => this.uploadChunk(i));
    }
  }

  private async uploadChunk(chunkIndex: number): Promise<void> {
    if (!this.file || !this.ws || this.isShuttingDown) return;

    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, this.file.size);
    const chunk = this.file.slice(start, end);
    const buffer = await chunk.arrayBuffer();

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buffer);
      console.log(`[v0] Sent chunk ${chunkIndex + 1}/${this.totalChunks}`);
    } else {
      throw new Error(`WebSocket not open (state: ${this.ws.readyState})`);
    }
  }

  private handleChunkAck(chunkIndex: number): void {
    this.uploadedChunks.add(chunkIndex);
    this.updateProgress();

    if (this.uploadedChunks.size === this.totalChunks) {
      console.log('[v0] All chunks uploaded, waiting for assembly...');
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'done' }));
      }
    }
  }

  private updateProgress(): void {
    if (!this.file || !this.onProgress) return;

    const uploadedBytes = this.uploadedChunks.size * CHUNK_SIZE;
    const progress: UploadProgress = {
      uploadedBytes: Math.min(uploadedBytes, this.file.size),
      totalBytes: this.file.size,
      percentage: Math.round((this.uploadedChunks.size / this.totalChunks) * 100),
      chunksCompleted: this.uploadedChunks.size,
      totalChunks: this.totalChunks,
      currentChunk: this.uploadedChunks.size,
    };

    this.onProgress(progress);
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue
      .then(task)
      .catch((error) => {
        console.error('[v0] Upload error:', error);
        this.onError?.(error instanceof Error ? error.message : 'Upload failed');
      });
  }

  private shutdown(): void {
    this.isShuttingDown = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Export singleton instance
export const wsUploader = new WSChunkedUploader();

export async function uploadFileViaWS(options: UploadOptions): Promise<string> {
  return wsUploader.upload(options);
}
