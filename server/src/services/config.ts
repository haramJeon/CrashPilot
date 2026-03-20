import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { AppConfig, Platform } from '../types';
import { getAppRoot } from '../utils/appPaths';

const CONFIG_PATH = path.join(getAppRoot(), 'config.json');

export function getCurrentPlatform(): Platform {
  return os.platform() === 'darwin' ? 'macos' : 'windows';
}

// ── Encryption for sensitive fields in config.json ───────────────────────
// Prevents plaintext secrets from sitting in the config file on disk.
// Falls back gracefully if a value is already plaintext (migration-safe).
const ENC_KEY = crypto.createHash('sha256').update('CrashPilot-config-v1').digest();
const ENC_MARKER = 'enc:';

function encryptValue(value: string): string {
  if (!value || value.startsWith(ENC_MARKER)) return value;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ENC_MARKER + iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptValue(value: string): string {
  if (!value || !value.startsWith(ENC_MARKER)) return value; // plaintext legacy value
  try {
    const raw = value.slice(ENC_MARKER.length);
    const colonIdx = raw.indexOf(':');
    const iv = Buffer.from(raw.slice(0, colonIdx), 'hex');
    const encrypted = Buffer.from(raw.slice(colonIdx + 1), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENC_KEY, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return value; // return as-is if decryption fails
  }
}

/** Fields encrypted in config.json */
const SENSITIVE_FIELDS: { section: keyof AppConfig; key: string }[] = [
  { section: 'claude',   key: 'apiKey' },
  { section: 'github',   key: 'token' },
];

function encryptConfig(config: AppConfig): any {
  const out = JSON.parse(JSON.stringify(config)); // deep clone
  for (const { section, key } of SENSITIVE_FIELDS) {
    const sec = out[section] as any;
    if (sec && typeof sec[key] === 'string') {
      sec[key] = encryptValue(sec[key]);
    }
  }
  return out;
}

function decryptConfig(raw: any): any {
  const out = JSON.parse(JSON.stringify(raw));
  for (const { section, key } of SENSITIVE_FIELDS) {
    const sec = out[section] as any;
    if (sec && typeof sec[key] === 'string') {
      sec[key] = decryptValue(sec[key]);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AppConfig = {
  releaseBuildBaseDir: '',
  buildNetworkBaseDir: '',
  softwareBuildPaths: {},
  crashReportServer: {
    url: 'http://rnd3.meditlink.com:5001',
    softwareIds: [],
  },
  claude: {
    apiKey: '',
    model: 'claude-sonnet-4-6',
  },
  github: {
    token: '',
    owner: '',
    repo: '',
  },
  debugger: {
    windows: {
      cdbPath: 'C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe',
      symbolPath: '',
    },
    macos: {
      lldbPath: '/usr/bin/lldb',
      dsymPath: '',
    },
  },
  git: {
    repoUrl: 'https://github.com/medit-desktop-app/applications.git',
    repoBaseDir: '',
    branchPrefix: 'release/',
    defaultBranch: 'master',
    softwareTagFolders: {},
  },
};

export function loadConfig(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      const decrypted = decryptConfig(raw);
      return {
        ...DEFAULT_CONFIG,
        ...decrypted,
        crashReportServer: { ...DEFAULT_CONFIG.crashReportServer, ...decrypted.crashReportServer },
        claude: { ...DEFAULT_CONFIG.claude, ...decrypted.claude },
        github: { ...DEFAULT_CONFIG.github, ...decrypted.github },
        debugger: {
          windows: { ...DEFAULT_CONFIG.debugger.windows, ...decrypted.debugger?.windows },
          macos: { ...DEFAULT_CONFIG.debugger.macos, ...decrypted.debugger?.macos },
        },
        git: { ...DEFAULT_CONFIG.git, ...decrypted.git },
      };
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
  return DEFAULT_CONFIG;
}

export function saveConfig(config: AppConfig): void {
  const encrypted = encryptConfig(config);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(encrypted, null, 2), 'utf-8');
}
