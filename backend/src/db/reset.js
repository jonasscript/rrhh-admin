'use strict';
/**
 * reset.js — ⚠ RESET COMPLETO DE BASE DE DATOS ⚠
 *
 * ELIMINA TODAS LAS TABLAS Y TODOS LOS DATOS, luego recrea el esquema desde cero.
 * Usar SOLO en desarrollo / entornos de prueba.
 *
 * Uso: node src/db/reset.js --confirm
 */

const fs   = require('fs');
const path = require('path');
const { pool } = require('../config/db');
require('dotenv').config();

if (!process.argv.includes('--confirm')) {
  console.error('⛔  Operación cancelada.');
  console.error('    Este comando BORRA TODOS LOS DATOS de la base de datos.');
  console.error('    Para continuar ejecuta:  node src/db/reset.js --confirm');
  process.exit(1);
}

async function reset() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema-reset.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('✅ Reset completado — esquema recreado desde cero');
  } catch (err) {
    console.error('❌ Reset fallido:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

reset();
