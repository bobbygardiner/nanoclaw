import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { WAMessage, WASocket } from '@whiskeysockets/baileys';

import { logger } from './logger.js';

interface TranscriptionConfig {
  enabled: boolean;
  fallbackMessage: string;
  modelPath: string;
  whisperBin: string;
}

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const DEFAULT_CONFIG: TranscriptionConfig = {
  enabled: true,
  fallbackMessage: '[Voice Message - transcription unavailable]',
  modelPath: path.join(PROJECT_ROOT, 'data', 'whisper-models', 'ggml-base.bin'),
  whisperBin: '/opt/homebrew/bin/whisper-cli',
};

function transcribeWithWhisperCpp(
  audioBuffer: Buffer,
  config: TranscriptionConfig,
): string | null {
  if (!fs.existsSync(config.whisperBin)) {
    logger.warn({ bin: config.whisperBin }, 'whisper-cli not found');
    return null;
  }

  if (!fs.existsSync(config.modelPath)) {
    logger.warn({ model: config.modelPath }, 'Whisper model not found');
    return null;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-voice-'));
  const oggPath = path.join(tmpDir, 'voice.ogg');
  const wavPath = path.join(tmpDir, 'voice.wav');

  try {
    // Write OGG buffer to temp file
    fs.writeFileSync(oggPath, audioBuffer);

    // Convert OGG/Opus to 16kHz mono WAV (whisper-cpp can't read OGG despite claiming to)
    execFileSync('/opt/homebrew/bin/ffmpeg', [
      '-i', oggPath,
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      '-y', wavPath,
    ], { stdio: 'pipe', timeout: 30_000 });

    // Run whisper-cli
    const stdout = execFileSync(config.whisperBin, [
      '--model', config.modelPath,
      '--file', wavPath,
      '--no-timestamps',
      '--language', 'en',
    ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000, encoding: 'utf-8' });

    // whisper-cli outputs transcript lines to stdout, with optional timestamps
    // With --no-timestamps, lines are plain text (may have leading whitespace)
    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const transcript = lines.join(' ').trim();
    if (!transcript) {
      logger.warn('whisper-cli produced empty transcript');
      return null;
    }

    return transcript;
  } catch (err: any) {
    logger.error({
      err: err.message,
      stderr: err.stderr?.toString()?.slice(0, 500),
    }, 'Local Whisper transcription failed');
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const config = DEFAULT_CONFIG;

  if (!config.enabled) {
    return null;
  }

  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      logger.error('Failed to download audio message');
      return null;
    }

    logger.info({ bytes: buffer.length }, 'Downloaded audio message');

    const transcript = transcribeWithWhisperCpp(buffer, config);
    return transcript;
  } catch (err) {
    logger.error({ err }, 'Transcription error');
    return null;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
