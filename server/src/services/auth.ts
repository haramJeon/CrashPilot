import {
  PublicClientApplication,
  CryptoProvider,
  AccountInfo,
} from '@azure/msal-node';
import fs from 'fs';
import path from 'path';
import { loadConfig } from './config';

const TOKEN_CACHE_PATH = path.join(__dirname, '../../../token-cache.json');
const REDIRECT_URI = 'http://localhost:3001/api/auth/callback';
const SCOPES = ['Mail.Read', 'User.Read', 'offline_access'];

// In-memory PKCE state (per auth session)
let pkceState: { verifier: string; challenge: string } | null = null;
let authCodeUrlState: string | null = null;

function buildPca(): PublicClientApplication {
  const config = loadConfig();

  const tokenCache = fs.existsSync(TOKEN_CACHE_PATH)
    ? fs.readFileSync(TOKEN_CACHE_PATH, 'utf-8')
    : '{}';

  const pca = new PublicClientApplication({
    auth: {
      clientId: config.outlook.clientId,
      authority: `https://login.microsoftonline.com/${config.outlook.tenantId}`,
    },
    cache: {
      cachePlugin: {
        beforeCacheAccess: async (ctx) => {
          ctx.tokenCache.deserialize(
            fs.existsSync(TOKEN_CACHE_PATH)
              ? fs.readFileSync(TOKEN_CACHE_PATH, 'utf-8')
              : '{}'
          );
        },
        afterCacheAccess: async (ctx) => {
          if (ctx.cacheHasChanged) {
            fs.writeFileSync(TOKEN_CACHE_PATH, ctx.tokenCache.serialize(), 'utf-8');
          }
        },
      },
    },
  });

  // Pre-load cache
  pca.getTokenCache().deserialize(tokenCache);

  return pca;
}

export async function getAuthUrl(): Promise<string> {
  const pca = buildPca();
  const crypto = new CryptoProvider();
  const { verifier, challenge } = await crypto.generatePkceCodes();

  pkceState = { verifier, challenge };
  authCodeUrlState = crypto.createNewGuid();

  const url = await pca.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    state: authCodeUrlState,
  });

  return url;
}

export async function handleCallback(code: string, state: string): Promise<void> {
  if (state !== authCodeUrlState) {
    throw new Error('Invalid state parameter');
  }
  if (!pkceState) {
    throw new Error('No PKCE verifier found');
  }

  const pca = buildPca();
  await pca.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    codeVerifier: pkceState.verifier,
  });

  pkceState = null;
  authCodeUrlState = null;
}

export async function getAccessToken(): Promise<string> {
  const pca = buildPca();
  const accounts = await pca.getTokenCache().getAllAccounts();

  if (accounts.length === 0) {
    throw new Error('Not authenticated. Please connect your Outlook account.');
  }

  const result = await pca.acquireTokenSilent({
    account: accounts[0] as AccountInfo,
    scopes: SCOPES,
  });

  if (!result?.accessToken) {
    throw new Error('Failed to acquire token silently.');
  }

  return result.accessToken;
}

export async function getAuthStatus(): Promise<{
  connected: boolean;
  account?: string;
}> {
  try {
    const pca = buildPca();
    const accounts = await pca.getTokenCache().getAllAccounts();
    if (accounts.length === 0) return { connected: false };
    return { connected: true, account: accounts[0].username };
  } catch {
    return { connected: false };
  }
}

export async function logout(): Promise<void> {
  if (fs.existsSync(TOKEN_CACHE_PATH)) {
    fs.unlinkSync(TOKEN_CACHE_PATH);
  }
}
