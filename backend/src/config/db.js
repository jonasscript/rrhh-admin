const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL error:', err.message);
});

/**
 * Ejecuta una query SQL con parámetros opcionales.
 * @param {string} text  — SQL con $1, $2… placeholders
 * @param {Array}  params — valores de los parámetros
 */
const query = (text, params) => pool.query(text, params);

/**
 * Obtiene un cliente del pool para transacciones manuales.
 * Siempre liberar con client.release() en finally.
 */
const getClient = () => pool.connect();

module.exports = { query, getClient, pool };
