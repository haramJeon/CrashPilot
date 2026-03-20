import fs from 'fs';
import os from 'os';
import path from 'path';
import { AppConfig, Platform } from '../types';
import { getAppRoot } from '../utils/appPaths';

const CONFIG_PATH = path.join(getAppRoot(), 'config.json');

export function getCurrentPlatform(): Platform {
  return os.platform() === 'darwin' ? 'macos' : 'windows';
}

function encryptConfig(config: AppConfig): any {
  return JSON.parse(JSON.stringify(config));
}

function decryptConfig(raw: any): any {
  return JSON.parse(JSON.stringify(raw));
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
    model: 'claude-sonnet-4-6',
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
    defaultBranch: 'develop',
    softwareTagFolders: {},
  },
};

/** Fill empty dir fields with defaults relative to the app root (exe directory). */
function applyDirDefaults(config: AppConfig): AppConfig {
  const appRoot = getAppRoot();
  return {
    ...config,
    releaseBuildBaseDir: config.releaseBuildBaseDir || path.join(appRoot, 'pdb'),
    git: {
      ...config.git,
      repoBaseDir: config.git.repoBaseDir || path.join(appRoot, 'repository'),
    },
  };
}

export function loadConfig(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      const decrypted = decryptConfig(raw);
      const merged: AppConfig = {
        ...DEFAULT_CONFIG,
        ...decrypted,
        crashReportServer: { ...DEFAULT_CONFIG.crashReportServer, ...decrypted.crashReportServer },
        claude: { ...DEFAULT_CONFIG.claude, ...decrypted.claude },
        debugger: {
          windows: { ...DEFAULT_CONFIG.debugger.windows, ...decrypted.debugger?.windows },
          macos: { ...DEFAULT_CONFIG.debugger.macos, ...decrypted.debugger?.macos },
        },
        git: { ...DEFAULT_CONFIG.git, ...decrypted.git },
      };
      return applyDirDefaults(merged);
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
  return applyDirDefaults(DEFAULT_CONFIG);
}

export function saveConfig(config: AppConfig): void {
  const encrypted = encryptConfig(config);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(encrypted, null, 2), 'utf-8');
}
