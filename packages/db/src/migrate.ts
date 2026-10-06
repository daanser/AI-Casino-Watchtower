/**
 * 迁移入口： npm run migrate
 */

import { DEFAULT_DB_PATH, migrate, openDb } from './index';

const dbPath = process.argv[2] ?? DEFAULT_DB_PATH;
const db = openDb(dbPath);
const applied = migrate(db);
db.close();

if (applied.length === 0) {
  console.log(`数据库已是最新：${dbPath}`);
} else {
  console.log(`已应用 ${applied.length} 个迁移到 ${dbPath}`);
  for (const name of applied) console.log(`  + ${name}`);
}
