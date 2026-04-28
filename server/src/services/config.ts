import fs from 'fs';
import os from 'os';
import path from 'path';
import { AppConfig, Platform } from '../types';
import { getAppRoot, getDataRoot } from '../utils/appPaths';

const CONFIG_PATH = path.join(getDataRoot(), 'config.json');

export function getCurrentPlatform(): Platform {
  return os.platform() === 'darwin' ? 'macos' : 'windows';
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
  // Sourced from Confluence "Medit Link Apps Release" (Kernel/Addin kit column, front half = kernel ver)
  kernelVersionMap: {
    "3": { // Medit Smile Design
      "1.2.4.70": "1.20.0.18",
      "1.2.3.57": "1.20.0.14",
      "1.2.2.32": "1.10.0.94",
      "1.2.1.28": "1.10.0.94",
      "1.2.0.22": "1.10.0.89",
      "1.1.1.48": "1.5.1.40",
    },
    "4": { // Medit Ortho Simulation
      "1.4.3.7":  "1.32.0.26",
      "1.4.2.77": "1.32.0.6",
      "1.4.1.74": "1.32.0.6",
      "1.4.0.65": "1.32.0.2",
      "1.3.2.48": "1.21.0.5",
      "1.3.1.43": "1.21.0.5",
      "1.3.0.34": "1.21.0.5",
      "1.2.3.65": "1.20.0.22",
      "1.2.2.59": "1.20.0.14",
      "1.2.1.29": "1.10.0.89",
      "1.2.0.27": "1.10.0.89",
      "1.1.2.52": "1.5.1.40",
      "1.1.1.47": "1.5.1.40",
    },
    "5": { // Medit Design
      "2.1.5.112": "1.19.1.21",
      "2.1.4.97":  "1.19.1.21",
      "2.1.3.95":  "1.19.1.21",
      "2.1.2.79":  "1.19.1.21",
      "2.1.1.72":  "1.19.0.15",
      "2.1.0.63":  "1.19.0.5",
      "2.1.0.47":  "1.19.0.5",
      "2.0.0.35":  "1.11.0.216",
      "1.2.0.31":  "1.7.0.5",
      "1.1.1.61":  "1.5.1.40",
    },
    "7": { // Medit Crown Fit
      "1.2.0.42": "1.32.0.25",
      "1.1.1.53": "1.20.0.14",
      "1.1.0.43": "1.10.0.94",
    },
    "8": { // Medit Model Builder
      "1.5.2.69": "1.38.0.82",
      "1.5.1.64": "1.38.0.78",
      "1.5.0.62": "1.38.0.78",
      "1.4.0.41": "1.36.0.27",
      "1.3.4.75": "1.22.1.180",
      "1.3.2.66": "1.22.1.170",
      "1.3.1.53": "1.22.1.168",
      "1.3.0.47": "1.22.0.163",
      "1.2.2.73": "1.19.0.15",
      "1.2.1.57": "1.19.0.15",
      "1.2.0.45": "1.12.0.68",
      "1.1.0.71": "1.9.1.97",
      "1.0.2.63": "1.6.2.213",
      "1.0.1.58": "1.6.0.196",
    },
    "11": { // Medit DCM Converter
      "0.9.1.48": "1.20.0.14",
      "0.9.1.45": "1.20.0.14",
      "0.9.0.27": "1.7.0.17",
    },
    "12": { // Medit Splints
      "1.0.4.134": "1.15.2.148",
      "1.0.3.133": "1.15.2.148",
      "1.0.3.132": "1.15.2.148",
      "1.0.2.122": "1.15.1.145",
      "1.0.1.103": "1.15.1.144",
      "1.0.1.48":  "1.15.0.141",
      "1.0.0.32":  "1.15.0.132",
      "0.9.0.30":  "1.15.0.46",
    },
    "13": { // Medit Margin Lines
      "1.2.0.54": "1.32.0.25",
      "1.0.0.32": "1.21.0.4",
    },
    "14": { // Medit Occlusion Analyzer
      "1.0.3.86": "1.23.0.18",
      "1.0.2.78": "1.23.0.18",
      "1.0.0.61": "1.23.0.18",
    },
    "15": { // Medit ClinicCAD
      "1.1.0.55":  "1.40.0.48",
      "1.0.0.127": "1.36.0.27",
      "0.9.6.508": "1.31.0.33",
      "0.9.5.490": "1.31.0.33",
      "0.9.3.334": "1.25.0.222",
      "0.9.2.279": "1.25.0.209",
      "0.9.1.84":  "1.25.0.173",
      "0.9.0.78":  "1.25.0.172",
    },
    "16": { // Medit Caries Detection
      "0.9.0.47": "1.24.0.142",
    },
    "17": { // Medit Orthodontic Suite
      "2.2.2.60": "1.39.0.74",
      "2.2.2.62": "1.39.0.74",
      "2.2.1.33": "1.39.0.73",
      "2.2.1.29": "1.39.0.73",
      "2.2.0.16": "1.39.0.73",
      "2.1.1.60": "1.39.0.56",
      "2.1.0.57": "1.39.0.56",
      "2.0.0.117":"1.37.0.48",
    },
    "18": { // Medit Surgical Guide
      "0.9.0.36": "1.34.0.56",
    },
  },
};

// Per-software (per-swId) deep merge so default kernel mappings survive even when
// user has added their own entries under the same softwareId.
function mergeKernelVersionMap(
  defaults: Record<string, Record<string, string>> = {},
  user: Record<string, Record<string, string>> = {},
): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const swId of new Set([...Object.keys(defaults), ...Object.keys(user)]))
  {
    result[swId] = { ...(defaults[swId] ?? {}), ...(user[swId] ?? {}) };
  }
  return result;
}

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
      const merged: AppConfig = {
        ...DEFAULT_CONFIG,
        ...raw,
        softwareBuildPaths: { ...DEFAULT_CONFIG.softwareBuildPaths, ...raw.softwareBuildPaths },
        crashReportServer: { ...DEFAULT_CONFIG.crashReportServer, ...raw.crashReportServer },
        claude: { ...DEFAULT_CONFIG.claude, ...raw.claude },
        debugger: {
          windows: { ...DEFAULT_CONFIG.debugger.windows, ...raw.debugger?.windows },
          macos: { ...DEFAULT_CONFIG.debugger.macos, ...raw.debugger?.macos },
        },
        git: {
          ...DEFAULT_CONFIG.git,
          ...raw.git,
          softwareTagFolders: { ...DEFAULT_CONFIG.git.softwareTagFolders, ...raw.git?.softwareTagFolders },
        },
        jira: { ...DEFAULT_CONFIG.jira, ...raw.jira },
        jiraSprintIds: { ...DEFAULT_CONFIG.jiraSprintIds, ...raw.jiraSprintIds },
        kernelVersionMap: mergeKernelVersionMap(DEFAULT_CONFIG.kernelVersionMap, raw.kernelVersionMap),
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}
