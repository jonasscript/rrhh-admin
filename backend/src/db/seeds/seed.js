require('dotenv').config();
const bcrypt  = require('bcryptjs');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const seed = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Sembrando datos iniciales...');

    // ── Usuario admin ─────────────────────────────────────────
    const hashed = await bcrypt.hash('Admin123!', 12);

    // ON CONFLICT: si ya existe el email, actualiza la contraseña y retorna el id
    const userRes = await client.query(
      `INSERT INTO users (id, email, password, role)
       VALUES ($1, 'admin@rrhh.com', $2, 'ADMIN')
       ON CONFLICT (email) DO UPDATE SET password = EXCLUDED.password
       RETURNING id`,
      [uuidv4(), hashed]
    );
    const adminId = userRes.rows[0].id;
    console.log('✓ Usuario admin:', adminId);

    // ── Departamentos ─────────────────────────────────────────
    const departments = [
      ['Gerencia',           'Dirección general'],
      ['Recursos Humanos',   'Gestión del talento humano'],
      ['Administración',     'Finanzas y contabilidad'],
      ['Operaciones',        'Operaciones y logística'],
      ['Seguridad',          'Guardias y vigilancia'],
      ['Mantenimiento',      'Mantenimiento de instalaciones'],
      ['Tecnología',         'Sistemas y tecnología'],
    ];

    for (const [name, description] of departments) {
      await client.query(
        `INSERT INTO departments (id, name, description)
         VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
        [uuidv4(), name, description]
      );
    }
    console.log('✓ Departamentos creados:', departments.length);

    // ── Plantillas de turno ───────────────────────────────────
    const shifts = [
      ['Diurno',     '06:00', '14:00', '#22c55e'],
      ['Vespertino', '14:00', '22:00', '#f59e0b'],
      ['Nocturno',   '22:00', '06:00', '#6366f1'],
      ['Completo',   '08:00', '17:00', '#3b82f6'],
      ['Medio',      '08:00', '13:00', '#ec4899'],
    ];

    for (const [name, startTime, endTime, color] of shifts) {
      await client.query(
        `INSERT INTO shift_templates (id, name, start_time, end_time, color)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (name) DO NOTHING`,
        [uuidv4(), name, startTime, endTime, color]
      );
    }
    console.log('✓ Plantillas de turno creadas:', shifts.length);

    // ── Configuración del condominio ──────────────────────────
    const existing = await client.query('SELECT id FROM condo_config LIMIT 1');
    if (!existing.rows.length) {
      await client.query(
        `INSERT INTO condo_config
           (id, name, admin_email, fixed_maintenance, fixed_security, fixed_cleaning, fixed_other,
            mora_enabled, mora_rate, mora_grace_days)
         VALUES ($1, 'Residencial Los Pinos', 'admin@rrhh.com', 500, 800, 300, 100, TRUE, 0.02, 5)`,
        [uuidv4()]
      );
      console.log('✓ Configuración de condominio creada');
    }

    await client.query('COMMIT');
    console.log('\n✅ Seed completado exitosamente');
    console.log('   Login: admin@rrhh.com / Admin123!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('✗ Error en seed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
};

seed().catch(() => process.exit(1));
