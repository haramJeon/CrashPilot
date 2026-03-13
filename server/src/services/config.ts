import fs from 'fs';
import os from 'os';
import path from 'path';
import { AppConfig, Platform } from '../types';

const CONFIG_PATH = path.join(__dirname, '../../../config.json');

export function getCurrentPlatform(): Platform {
  return os.platform() === 'darwin' ? 'macos' : 'windows';
}

const DEFAULT_CONFIG: AppConfig = {
  outlook: {
    clientId: '',
    tenantId: '',
    mailFilter: "subject:'Crash Report'",
  },
  claude: {
    apiKey: '',
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
    repoPath: '',
  },
};

export function loadConfig(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      // Deep merge to preserve nested defaults (e.g. debugger.windows when only debugger.macos is saved)
      return {
        ...DEFAULT_CONFIG,
        ...saved,
        outlook: { ...DEFAULT_CONFIG.outlook, ...saved.outlook },
        claude: { ...DEFAULT_CONFIG.claude, ...saved.claude },
        github: { ...DEFAULT_CONFIG.github, ...saved.github },
        debugger: {
          windows: { ...DEFAULT_CONFIG.debugger.windows, ...saved.debugger?.windows },
          macos: { ...DEFAULT_CONFIG.debugger.macos, ...saved.debugger?.macos },
        },
        git: { ...DEFAULT_CONFIG.git, ...saved.git },
      };
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
  return DEFAULT_CONFIG;
}

export function saveConfig(config: AppConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}
