import { Router } from 'express';
import { getAuthUrl, handleCallback, getAuthStatus, logout } from '../services/auth';

export const authRouter = Router();

// Start OAuth flow — returns the Microsoft login URL
authRouter.get('/login', async (_req, res) => {
  try {
    const url = await getAuthUrl();
    res.json({ url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// OAuth callback — Microsoft redirects here after login
authRouter.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.send(`
      <script>
        window.opener?.postMessage({ type: 'auth_error', error: '${error_description || error}' }, '*');
        window.close();
      </script>
    `);
  }

  try {
    await handleCallback(code as string, state as string);
    res.send(`
      <script>
        window.opener?.postMessage({ type: 'auth_success' }, '*');
        window.close();
      </script>
    `);
  } catch (err: any) {
    res.send(`
      <script>
        window.opener?.postMessage({ type: 'auth_error', error: '${err.message}' }, '*');
        window.close();
      </script>
    `);
  }
});

// Auth status
authRouter.get('/status', async (_req, res) => {
  const status = await getAuthStatus();
  res.json(status);
});

// Logout / disconnect
authRouter.post('/logout', async (_req, res) => {
  await logout();
  res.json({ success: true });
});
