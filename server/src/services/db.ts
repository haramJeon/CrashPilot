import mysql from 'mysql2/promise';
import { loadConfig } from './config';

function getConnection() {
  const { crashDb } = loadConfig();
  return mysql.createConnection({
    host: crashDb.host,
    port: crashDb.port,
    user: crashDb.user,
    password: crashDb.password,
    database: crashDb.database,
    connectTimeout: 5000,
  });
}

/**
 * Returns the release build directory name for a given software version.
 * Queries: SELECT directory FROM software_version WHERE software_id=? AND version=?
 * Falls back to matching sw_version major.minor.patch if exact match not found.
 */
export async function getVersionDirectory(softwareId: number, swVersion: string): Promise<string | null> {
  const conn = await getConnection();
  try {
    // Exact match first
    const [rows] = await conn.execute<any[]>(
      'SELECT directory FROM software_version WHERE software_id = ? AND version = ? ORDER BY id DESC LIMIT 1',
      [softwareId, swVersion]
    );
    if (rows.length > 0) return rows[0].directory as string;

    // Fallback: match by major.minor.patch (first 3 parts)
    const parts = swVersion.split('.');
    if (parts.length >= 3) {
      const partial = parts.slice(0, 3).join('.');
      const [rows2] = await conn.execute<any[]>(
        'SELECT directory FROM software_version WHERE software_id = ? AND version LIKE ? ORDER BY id DESC LIMIT 1',
        [softwareId, `${partial}%`]
      );
      if (rows2.length > 0) return rows2[0].directory as string;
    }

    return null;
  } finally {
    await conn.end();
  }
}
