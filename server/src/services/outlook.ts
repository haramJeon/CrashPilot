import { ConfidentialClientApplication } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import { loadConfig } from './config';
import { CrashEmail } from '../types';

function getGraphClient(): Client {
  const config = loadConfig();

  const cca = new ConfidentialClientApplication({
    auth: {
      clientId: config.outlook.clientId,
      clientSecret: config.outlook.clientSecret,
      authority: `https://login.microsoftonline.com/${config.outlook.tenantId}`,
    },
  });

  return Client.init({
    authProvider: async (done) => {
      try {
        const result = await cca.acquireTokenByClientCredential({
          scopes: ['https://graph.microsoft.com/.default'],
        });
        done(null, result?.accessToken || '');
      } catch (err) {
        done(err as Error, '');
      }
    },
  });
}

function parseCrashEmail(mail: any): CrashEmail | null {
  const body: string = mail.body?.content || '';

  // Extract dump download URL (http/https link ending with .dmp or containing dump-related keywords)
  const dumpUrlMatch = body.match(/https?:\/\/[^\s<>"]+\.dmp[^\s<>"]*/i)
    || body.match(/https?:\/\/[^\s<>"]+dump[^\s<>"]*/i)
    || body.match(/https?:\/\/[^\s<>"]+crash[^\s<>"]*/i);

  // Extract release branch (e.g., release/1.2.3, release-1.2.3, v1.2.3)
  const branchMatch = body.match(/(?:branch|release)[:\s]*([^\s<>"]+)/i)
    || body.match(/(release\/[\w.\-]+)/i)
    || body.match(/(v\d+\.\d+\.\d+[\w.\-]*)/i);

  if (!dumpUrlMatch) return null;

  return {
    id: mail.id,
    subject: mail.subject || 'No Subject',
    from: mail.from?.emailAddress?.address || 'unknown',
    receivedAt: mail.receivedDateTime || new Date().toISOString(),
    body: body,
    dumpUrl: dumpUrlMatch[0],
    releaseBranch: branchMatch ? branchMatch[1] : 'main',
    status: 'new',
  };
}

export async function fetchCrashEmails(): Promise<CrashEmail[]> {
  const config = loadConfig();
  const client = getGraphClient();

  const filter = config.outlook.mailFilter || "subject:'Crash Report'";

  const response = await client
    .api(`/users/${config.outlook.userId}/messages`)
    .filter(filter)
    .top(50)
    .orderby('receivedDateTime desc')
    .select('id,subject,from,receivedDateTime,body')
    .get();

  const emails: CrashEmail[] = [];
  for (const mail of response.value || []) {
    const parsed = parseCrashEmail(mail);
    if (parsed) {
      emails.push(parsed);
    }
  }

  return emails;
}
