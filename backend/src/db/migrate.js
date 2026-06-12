'use strict';
/**
 * migrate.js — Ejecuta schema.sql contra la base de datos.
 *
 * ⚠ BORRA Y RECREA todas las tablas (DROP IF EXISTS al inicio de schema.sql).
 *   Usar solo en instalación inicial o cuando se requiere un reset completo.
 *
 * Para reset completo de datos también:
 *   → Usar node src/db/reset.js
 */

const fs   = require('fs');
const path = require('path');
const { pool } = require('../config/db');
require('dotenv').config();

/* ─────────────────────────────────────────────────────────────────
   RUNNER
   ───────────────────────────────────────────────────────────────── */
async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const client = await pool.connect();

  try {
    await client.query(sql);
    console.log('✅ Migration completed — schema.sql applied successfully');
  } catch (err) {
    console.error('❌ Migration failed');
    console.error(err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
