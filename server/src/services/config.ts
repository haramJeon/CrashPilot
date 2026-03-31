import fs from 'fs';
import os from 'os';
import path from 'path';
import { AppConfig, Platform } from '../types';
import { getAppRoot, getDataRoot } from '../utils/appPaths';

const CONFIG_PATH = path.join(getDataRoot(), 'config.json');

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
  softwareBuildPaths: {
    "3": "Medit Add-in\\Medit Smile Design",
    "4": "Medit Add-in\\Medit Ortho Simulation",
    "5": "Medit Add-in\\Medit Design",
    "7": "Medit Add-in\\Medit Crown Fit",
    "8": "Medit Add-in\\Medit Model Builder",
    "10": "Medit Add-in\\Medit Calibration Wizard",
    "11": "Medit Add-in\\Medit DCM Converter",
    "12": "Medit Add-in\\Medit Splints",
    "13": "Medit Add-in\\Medit Margin Lines",
    "14": "Medit Add-in\\Medit Occlusion Analyzer",
    "15": "Medit Add-in\\Medit ClinicCAD",
    "16": "Medit Add-in\\Medit Caries Detection",
    "17": "Medit Add-in\\Medit Orthodontic Suite",
    "18": "Medit Add-in\\Medit Surgical Guide"
  },
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
  jira: {
    url: '',
    email: '',
    apiToken: '',
  },
  jiraSprintIds: {
    "1": 1734,
    "2": 1697,
    "3": 5937,
    "4": 5937,
    "5": 5938,
    "6": 2213,
    "7": 5938,
    "8": 5939,
    "9": 5937,
    "10": 1697,
    "11": 1697,
    "12": 5940,
    "13": 5937,
    "14": 5937,
    "15": 5937,
    "16": 2609,
    "17": 3299,
    "18": 5937,
  },
  git: {
    repoUrl: 'https://github.com/medit-desktop-app/applications.git',
    repoBaseDir: '',
    branchPrefix: 'release/',
    defaultBranch: 'develop',
    softwareTagFolders: {
      "1": "",
      "3": "smileDesign",
      "4": "orthoSimulation",
      "5": "Design",
      "7": "CrownFit",
      "8": "modelBuilder",
      "11": "DCMConverter",
      "12": "splints",
      "13": "marginLines",
      "14": "occlusionAnalyzer",
      "15": "cad",
      "16": "cariesDetection",
      "17": "pos"
    },
  },
};

/** Fill empty dir fields with defaults relative to the app root (exe directory). */
function applyDirDefaults(config: AppConfig): AppConfig {
  const appRoot = getAppRoot();
  const platform = getCurrentPlatform();
  const defaultNetworkBase = platform === 'macos'
    ? '//10.100.1.20/Build_Repository/Product_Release'
    : '\\\\10.100.1.20\\Build_Repository\\Product_Release';
  return {
    ...config,
    releaseBuildBaseDir: config.releaseBuildBaseDir || path.join(appRoot, 'pdb'),
    buildNetworkBaseDir: config.buildNetworkBaseDir || defaultNetworkBase,
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
        softwareBuildPaths: { ...DEFAULT_CONFIG.softwareBuildPaths, ...decrypted.softwareBuildPaths },
        crashReportServer: { ...DEFAULT_CONFIG.crashReportServer, ...decrypted.crashReportServer },
        claude: { ...DEFAULT_CONFIG.claude, ...decrypted.claude },
        debugger: {
          windows: { ...DEFAULT_CONFIG.debugger.windows, ...decrypted.debugger?.windows },
          macos: { ...DEFAULT_CONFIG.debugger.macos, ...decrypted.debugger?.macos },
        },
        git: {
          ...DEFAULT_CONFIG.git,
          ...decrypted.git,
          softwareTagFolders: { ...DEFAULT_CONFIG.git.softwareTagFolders, ...decrypted.git?.softwareTagFolders },
        },
        jira: { ...DEFAULT_CONFIG.jira, ...decrypted.jira },
        jiraSprintIds: { ...DEFAULT_CONFIG.jiraSprintIds, ...decrypted.jiraSprintIds },
      };
      return applyDirDefaults(merged);
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
  const defaults = applyDirDefaults(DEFAULT_CONFIG);
  saveConfig(defaults);
  return defaults;
}

export function saveConfig(config: AppConfig): void {
  const encrypted = encryptConfig(config);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(encrypted, null, 2), 'utf-8');
}
