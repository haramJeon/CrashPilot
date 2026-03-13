import { Client } from '@microsoft/microsoft-graph-client';
import { getAccessToken } from './auth';
import { loadConfig } from './config';
import { CrashEmail } from '../types';

function getGraphClient(): Client {
  return Client.init({
    authProvider: async (done) => {
      try {
        const token = await getAccessToken();
        done(null, token);
      } catch (err) {
        done(err as Error, '');
      }
    },
  });
}

function parseCrashEmail(mail: any): CrashEmail | null {
  const body: string = mail.body?.content || '';

  // Extract dump download URL
  const dumpUrlMatch =
    body.match(/https?:\/\/[^\s<>"]+\.dmp[^\s<>"]*/i) ||
    body.match(/https?:\/\/[^\s<>"]+dump[^\s<>"]*/i) ||
    body.match(/https?:\/\/[^\s<>"]+crash[^\s<>"]*/i);

  // Extract release branch
  const branchMatch =
    body.match(/(?:branch|release)[:\s]*([^\s<>"]+)/i) ||
    body.match(/(release\/[\w.\-]+)/i) ||
    body.match(/(v\d+\.\d+\.\d+[\w.\-]*)/i);

  if (!dumpUrlMatch) return null;

  return {
    id: mail.id,
    subject: mail.subject || 'No Subject',
    from: mail.from?.emailAddress?.address || 'unknown',
    receivedAt: mail.receivedDateTime || new Date().toISOString(),
    body,
    dumpUrl: dumpUrlMatch[0],
    releaseBranch: branchMatch ? branchMatch[1] : 'main',
    status: 'new',
  };
}

export async function fetchCrashEmails(): Promise<CrashEmail[]> {
  const config = loadConfig();
  const client = getGraphClient();
  const filter = config.outlook.mailFilter || "subject:'Crash Report'";

  // /me/messages uses the signed-in user's mailbox (delegated)
  const response = await client
    .api('/me/messages')
    .filter(filter)
    .top(50)
    .orderby('receivedDateTime desc')
    .select('id,subject,from,receivedDateTime,body')
    .get();

  const emails: CrashEmail[] = [];
  for (const mail of response.value || []) {
    const parsed = parseCrashEmail(mail);
    if (parsed) emails.push(parsed);
  }

  return emails;
}
