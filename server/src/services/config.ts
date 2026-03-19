import fs from 'fs';
import os from 'os';
import path from 'path';
import { AppConfig, Platform } from '../types';
import { getAppRoot } from '../utils/appPaths';

const CONFIG_PATH = path.join(getAppRoot(), 'config.json');

export function getCurrentPlatform(): Platform {
  return os.platform() === 'darwin' ? 'macos' : 'windows';
}

const DEFAULT_CONFIG: AppConfig = {
  releaseBuildBaseDir: '',
  buildNetworkBaseDir: '',
  softwareBuildPaths: {},
  crashDb: {
    host: '10.100.1.46',
    port: 3306,
    user: 'root',
    password: 'admin',
    database: 'crash_report',
  },
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
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return {
        ...DEFAULT_CONFIG,
        ...saved,
        crashReportServer: { ...DEFAULT_CONFIG.crashReportServer, ...saved.crashReportServer },
        crashDb: { ...DEFAULT_CONFIG.crashDb, ...saved.crashDb },
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
